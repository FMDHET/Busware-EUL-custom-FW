#include "config_store.h"
#include "security.h"

#include <string.h>
#include <stdio.h>

#include "nvs.h"
#include "nvs_flash.h"
#include "esp_mac.h"
#include "esp_log.h"

static const char *TAG = "eul-cfg";
static const char *NS  = "eulcfg";

static char s_device_suffix[7] = {0};

static void ensure_device_suffix(void)
{
    if (s_device_suffix[0]) return;
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_device_suffix, sizeof(s_device_suffix), "%02X%02X%02X",
             mac[3], mac[4], mac[5]);
}

const char *config_device_suffix(void)
{
    ensure_device_suffix();
    return s_device_suffix;
}

static esp_err_t read_str(nvs_handle_t h, const char *key, char *out, size_t out_size)
{
    size_t len = out_size;
    esp_err_t r = nvs_get_str(h, key, out, &len);
    if (r == ESP_ERR_NVS_NOT_FOUND) {
        out[0] = '\0';
        return ESP_OK;
    }
    return r;
}

static esp_err_t read_u8(nvs_handle_t h, const char *key, uint8_t *out, uint8_t def)
{
    esp_err_t r = nvs_get_u8(h, key, out);
    if (r == ESP_ERR_NVS_NOT_FOUND) { *out = def; return ESP_OK; }
    return r;
}

static esp_err_t read_u16(nvs_handle_t h, const char *key, uint16_t *out, uint16_t def)
{
    esp_err_t r = nvs_get_u16(h, key, out);
    if (r == ESP_ERR_NVS_NOT_FOUND) { *out = def; return ESP_OK; }
    return r;
}

// Falls Zufallswerte fehlen (Erstboot), einmalig generieren und schreiben.
static esp_err_t ensure_random_defaults(nvs_handle_t h, eul_config_t *cfg)
{
    bool dirty = false;
    if (cfg->ap_pass[0] == '\0') {
        sec_random_password(cfg->ap_pass, sizeof(cfg->ap_pass), EUL_AP_PASS_LEN);
        ESP_ERROR_CHECK(nvs_set_str(h, "ap_pass", cfg->ap_pass));
        dirty = true;
    }
    if (cfg->admin_pass[0] == '\0') {
        sec_random_password(cfg->admin_pass, sizeof(cfg->admin_pass), EUL_ADMIN_PASS_LEN);
        ESP_ERROR_CHECK(nvs_set_str(h, "admin_pass", cfg->admin_pass));
        dirty = true;
    }
    if (cfg->tcp_token[0] == '\0') {
        sec_random_token(cfg->tcp_token, sizeof(cfg->tcp_token));
        ESP_ERROR_CHECK(nvs_set_str(h, "tcp_token", cfg->tcp_token));
        dirty = true;
    }
    if (dirty) {
        ESP_ERROR_CHECK(nvs_commit(h));
        ESP_LOGI(TAG, "factory secrets initialized");
    }
    return ESP_OK;
}

// Sanity: provisioned=true erfordert eine non-empty SSID UND non-empty PW.
// Wenn irgendeine Ecke der Firmware das mal kaputt gemacht hat (Bug oder
// Crash mitten in einem Save), erkennen wir es hier und fallen sauber zurueck
// in den unprovisionierten Zustand statt endlos STA-Retries zu fahren.
static void sanity_check_and_fix(nvs_handle_t h, eul_config_t *cfg)
{
    if (!cfg->provisioned) return;
    if (cfg->wifi_ssid[0] && cfg->wifi_pass[0]) return;

    sec_event("config_sanity",
              "provisioned=1 but wifi_ssid=%s pw=%s -> reverting to unprovisioned",
              cfg->wifi_ssid[0] ? "set" : "empty",
              cfg->wifi_pass[0] ? "set" : "empty");
    cfg->provisioned = false;
    (void)nvs_set_u8(h, "provisioned", 0);
    (void)nvs_commit(h);
}

esp_err_t config_load(eul_config_t *out)
{
    if (!out) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));
    ensure_device_suffix();

    nvs_handle_t h;
    esp_err_t r = nvs_open(NS, NVS_READWRITE, &h);
    if (r != ESP_OK) return r;

    uint8_t u8;
    ESP_ERROR_CHECK(read_u8(h,  "provisioned", &u8, 0)); out->provisioned = u8 != 0;
    ESP_ERROR_CHECK(read_u8(h,  "usb_en",      &u8, 0)); out->usb_enabled = u8 != 0;
    ESP_ERROR_CHECK(read_u8(h,  "tcp_en",      &u8, 1)); out->tcp_enabled = u8 != 0;
    ESP_ERROR_CHECK(read_u8(h,  "tcp_authreq", &u8, 1)); out->tcp_auth_required = u8 != 0;
    ESP_ERROR_CHECK(read_u16(h, "tcp_port",    &out->tcp_port, CONFIG_EUL_DEFAULT_TCP_PORT));

    ESP_ERROR_CHECK(read_str(h, "wifi_ssid",  out->wifi_ssid,  sizeof(out->wifi_ssid)));
    ESP_ERROR_CHECK(read_str(h, "wifi_pass",  out->wifi_pass,  sizeof(out->wifi_pass)));
    ESP_ERROR_CHECK(read_str(h, "ap_pass",    out->ap_pass,    sizeof(out->ap_pass)));
    ESP_ERROR_CHECK(read_str(h, "admin_pass", out->admin_pass, sizeof(out->admin_pass)));
    ESP_ERROR_CHECK(read_str(h, "tcp_token",  out->tcp_token,  sizeof(out->tcp_token)));

    ESP_ERROR_CHECK(read_u8(h,  "api_en",    &u8, 0)); out->api_enabled  = u8 != 0;
    ESP_ERROR_CHECK(read_u8(h,  "mqtt_en",   &u8, 0)); out->mqtt_enabled = u8 != 0;
    ESP_ERROR_CHECK(read_u16(h, "mqtt_port", &out->mqtt_port, 1883));
    ESP_ERROR_CHECK(read_str(h, "mqtt_host",  out->mqtt_host,  sizeof(out->mqtt_host)));
    ESP_ERROR_CHECK(read_str(h, "mqtt_user",  out->mqtt_user,  sizeof(out->mqtt_user)));
    ESP_ERROR_CHECK(read_str(h, "mqtt_pass",  out->mqtt_pass,  sizeof(out->mqtt_pass)));
    ESP_ERROR_CHECK(read_str(h, "mqtt_topic", out->mqtt_topic, sizeof(out->mqtt_topic)));

    ESP_ERROR_CHECK(ensure_random_defaults(h, out));
    sanity_check_and_fix(h, out);

    nvs_close(h);
    return ESP_OK;
}

// -----------------------------------------------------------------------------
// Feinkoernige Setter. Jeder oeffnet NVS, aendert nur seinen Keyset, committet.
// -----------------------------------------------------------------------------

esp_err_t config_save_wifi(const char *ssid, const char *pass)
{
    if (!ssid || !ssid[0] || !pass || !pass[0]) {
        // Paar-Semantik: nie halbe Credentials schreiben.
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t h;
    esp_err_t r = nvs_open(NS, NVS_READWRITE, &h);
    if (r != ESP_OK) return r;

    r  = nvs_set_str(h, "wifi_ssid", ssid);
    if (r == ESP_OK) r = nvs_set_str(h, "wifi_pass", pass);
    if (r == ESP_OK) r = nvs_set_u8(h,  "provisioned", 1);
    if (r == ESP_OK) r = nvs_commit(h);
    nvs_close(h);

    if (r == ESP_OK) sec_event("wifi_creds_set", "ssid=%s (pw hidden)", ssid);
    else             sec_event("wifi_creds_fail", "err=%d", r);
    return r;
}

esp_err_t config_save_modes(bool usb_enabled,
                             bool tcp_enabled,
                             bool tcp_auth_required,
                             uint16_t tcp_port)
{
    nvs_handle_t h;
    esp_err_t r = nvs_open(NS, NVS_READWRITE, &h);
    if (r != ESP_OK) return r;

    if (tcp_port == 0) tcp_port = CONFIG_EUL_DEFAULT_TCP_PORT;

    r  = nvs_set_u8( h, "usb_en",      usb_enabled ? 1 : 0);
    if (r == ESP_OK) r = nvs_set_u8( h, "tcp_en",      tcp_enabled ? 1 : 0);
    if (r == ESP_OK) r = nvs_set_u8( h, "tcp_authreq", tcp_auth_required ? 1 : 0);
    if (r == ESP_OK) r = nvs_set_u16(h, "tcp_port",    tcp_port);
    if (r == ESP_OK) r = nvs_commit(h);
    nvs_close(h);

    if (r == ESP_OK) {
        sec_event("modes_set", "usb=%d tcp=%d auth=%d port=%u",
                  usb_enabled, tcp_enabled, tcp_auth_required, tcp_port);
    }
    return r;
}

esp_err_t config_save_integrations(bool api_enabled,
                                   bool mqtt_enabled,
                                   const char *mqtt_host,
                                   uint16_t mqtt_port,
                                   const char *mqtt_user,
                                   const char *mqtt_pass,
                                   const char *mqtt_topic)
{
    nvs_handle_t h;
    esp_err_t r = nvs_open(NS, NVS_READWRITE, &h);
    if (r != ESP_OK) return r;

    if (mqtt_port == 0) mqtt_port = 1883;

    r  = nvs_set_u8( h, "api_en",     api_enabled  ? 1 : 0);
    if (r == ESP_OK) r = nvs_set_u8( h, "mqtt_en",   mqtt_enabled ? 1 : 0);
    if (r == ESP_OK) r = nvs_set_u16(h, "mqtt_port", mqtt_port);
    if (r == ESP_OK) r = nvs_set_str(h, "mqtt_host",  mqtt_host  ? mqtt_host  : "");
    if (r == ESP_OK) r = nvs_set_str(h, "mqtt_user",  mqtt_user  ? mqtt_user  : "");
    if (r == ESP_OK) r = nvs_set_str(h, "mqtt_pass",  mqtt_pass  ? mqtt_pass  : "");
    if (r == ESP_OK) r = nvs_set_str(h, "mqtt_topic", mqtt_topic ? mqtt_topic : "");
    if (r == ESP_OK) r = nvs_commit(h);
    nvs_close(h);

    if (r == ESP_OK) {
        sec_event("integrations_set", "api=%d mqtt=%d host=%s port=%u",
                  api_enabled, mqtt_enabled, mqtt_host ? mqtt_host : "", mqtt_port);
    }
    return r;
}

esp_err_t config_regen_tcp_token(char *out, size_t out_size)
{
    char tok[EUL_TCP_TOKEN_MAX];
    sec_random_token(tok, sizeof(tok));

    nvs_handle_t h;
    esp_err_t r = nvs_open(NS, NVS_READWRITE, &h);
    if (r != ESP_OK) return r;
    r  = nvs_set_str(h, "tcp_token", tok);
    if (r == ESP_OK) r = nvs_commit(h);
    nvs_close(h);
    if (r != ESP_OK) return r;

    if (out && out_size >= sizeof(tok)) strcpy(out, tok);
    sec_event("tcp_token_regen", "new token issued");
    return ESP_OK;
}

esp_err_t config_set_admin_pass(const char *new_pass)
{
    if (!new_pass || strlen(new_pass) < 8) return ESP_ERR_INVALID_ARG;
    nvs_handle_t h;
    esp_err_t r = nvs_open(NS, NVS_READWRITE, &h);
    if (r != ESP_OK) return r;
    r  = nvs_set_str(h, "admin_pass", new_pass);
    if (r == ESP_OK) r = nvs_commit(h);
    nvs_close(h);
    if (r == ESP_OK) sec_event("admin_pass_change", "admin password rotated");
    return r;
}

esp_err_t config_factory_reset(void)
{
    nvs_handle_t h;
    esp_err_t r = nvs_open(NS, NVS_READWRITE, &h);
    if (r != ESP_OK) return r;
    ESP_ERROR_CHECK(nvs_erase_all(h));
    ESP_ERROR_CHECK(nvs_commit(h));
    nvs_close(h);
    sec_event("factory_reset", "nvs wiped");
    return ESP_OK;
}
