#include "wifi_ap.h"
#include "config_store.h"
#include "sdkconfig.h"

#include <string.h>
#include <stdio.h>

#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"

static const char *TAG = "eul-ap";

static char s_ssid[33];
static char s_ip[16] = "192.168.4.1";

esp_err_t wifi_ap_start(const char *pass)
{
    if (!pass || strlen(pass) < 8) return ESP_ERR_INVALID_ARG;

    snprintf(s_ssid, sizeof(s_ssid), "%s-%s",
             CONFIG_EUL_AP_SSID_PREFIX, config_device_suffix());

    // Idempotent - beim STA->AP-Fallback existieren die Netifs ggf. schon.
    if (!esp_netif_get_handle_from_ifkey("WIFI_AP_DEF")) {
        esp_netif_create_default_wifi_ap();
    }
    // STA-Netif zusaetzlich anlegen, damit das Portal im AP-Modus scannen kann.
    if (!esp_netif_get_handle_from_ifkey("WIFI_STA_DEF")) {
        esp_netif_create_default_wifi_sta();
    }

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    wifi_config_t wc = { 0 };
    strncpy((char *)wc.ap.ssid, s_ssid, sizeof(wc.ap.ssid) - 1);
    wc.ap.ssid_len = strlen(s_ssid);
    strncpy((char *)wc.ap.password, pass, sizeof(wc.ap.password) - 1);
    wc.ap.authmode = WIFI_AUTH_WPA2_PSK;
    wc.ap.max_connection = 4;
    wc.ap.channel = 6;
    wc.ap.pmf_cfg.required = false;

    // APSTA damit esp_wifi_scan_start im Portal funktioniert
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "softap up: ssid='%s' ip=%s", s_ssid, s_ip);
    return ESP_OK;
}

const char *wifi_ap_ssid(void)   { return s_ssid; }
const char *wifi_ap_ip_str(void) { return s_ip;   }
