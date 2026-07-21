#include "wifi_sta.h"
#include "security.h"
#include "sdkconfig.h"

#include <string.h>

#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

static const char *TAG = "eul-sta";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1
#define WIFI_MAX_RETRY     20

static EventGroupHandle_t s_wifi_evt;
static int  s_retry = 0;
static char s_ip[16];
static bool s_started = false;
static bool s_ever_connected = false;   // true, sobald wir einmal eine IP hatten
static esp_event_handler_instance_t s_h_wifi, s_h_ip;

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = (wifi_event_sta_disconnected_t *)data;
        s_ip[0] = '\0';
        xEventGroupClearBits(s_wifi_evt, WIFI_CONNECTED_BIT);
        if (s_ever_connected) {
            // Laufzeit-Drop nach schon erfolgreicher Verbindung: NIE aufgeben.
            // Der alte WIFI_MAX_RETRY-Deckel liess das Gateway nach einem
            // WLAN-Schluckauf tot liegen (bis Power-Cycle) - genau die Ursache
            // der zeitweisen Unerreichbarkeit / fehlenden Feedback-Telegramme.
            ESP_LOGW(TAG, "disconnected reason=%d, reconnecting (runtime)", e->reason);
            esp_wifi_connect();
        } else if (s_retry < WIFI_MAX_RETRY) {
            s_retry++;
            ESP_LOGW(TAG, "disconnected reason=%d, retry %d/%d",
                     e->reason, s_retry, WIFI_MAX_RETRY);
            esp_wifi_connect();
        } else {
            // Nur beim allerersten Verbinden (Boot) geben wir auf -> Fallback
            // in den Provisioning-Modus statt endlos gegen falsche Credentials.
            sec_event("wifi_connect_fail",
                      "STA cannot associate after %d retries (last reason=%d)",
                      s_retry, e->reason);
            xEventGroupSetBits(s_wifi_evt, WIFI_FAIL_BIT);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&e->ip_info.ip));
        ESP_LOGI(TAG, "got ip: %s", s_ip);
        s_retry = 0;
        s_ever_connected = true;
        xEventGroupSetBits(s_wifi_evt, WIFI_CONNECTED_BIT);
    }
}

esp_err_t wifi_sta_start_and_wait(const char *ssid, const char *pass, TickType_t timeout)
{
    if (!ssid || !ssid[0]) return ESP_ERR_INVALID_ARG;

    s_wifi_evt = xEventGroupCreate();

    // Netif + Event Loop erwarten wir bereits initialisiert (in mode_mgr).
    // Idempotent: bei einem STA<->AP-Wechsel existiert die Netif ggf. schon.
    if (!esp_netif_get_handle_from_ifkey("WIFI_STA_DEF")) {
        esp_netif_create_default_wifi_sta();
    }

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &on_event, NULL, &s_h_wifi));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &on_event, NULL, &s_h_ip));

    wifi_config_t wc = { 0 };
    strncpy((char *)wc.sta.ssid,     ssid, sizeof(wc.sta.ssid) - 1);
    if (pass) strncpy((char *)wc.sta.password, pass, sizeof(wc.sta.password) - 1);
    wc.sta.threshold.authmode = (pass && pass[0]) ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    wc.sta.pmf_cfg.capable = true;
    // Unter einer Mesh-SSID (mehrere FRITZ!Box-/Repeater-Knoten) den STAERKSTEN
    // AP nehmen. Default ist Fast-Scan = erster gefundener Treffer, nicht der
    // beste; deshalb landete der Dongle auf einem -92 dBm-Knoten. Der ESP32
    // roamt nach dem Connect nicht selbst (kein 802.11k/v/r), also zaehlt die
    // Wahl beim Verbinden. Kein RSSI-Threshold, damit er sich zur Not auch an
    // einem schwachen AP noch verbindet.
    wc.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    wc.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    // Kein Modem-Sleep: dieses Gateway muss Einmal-Telegramme (local_push) in
    // Echtzeit fangen und dauerhaft per TCP erreichbar sein. Der Default
    // (WIFI_PS_MIN_MODEM) legt den Funk zwischen Beacons schlafen -> Pakete
    // gehen verloren und die Station wirkt zeitweise "Host unreachable".
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    s_started = true;

    ESP_LOGI(TAG, "connecting to '%s' ...", ssid);

    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_evt,
        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdFALSE, pdFALSE, timeout);

    if (bits & WIFI_CONNECTED_BIT) return ESP_OK;
    if (bits & WIFI_FAIL_BIT)      return ESP_FAIL;
    return ESP_ERR_TIMEOUT;
}

const char *wifi_sta_ip_str(void)
{
    return s_ip[0] ? s_ip : NULL;
}

void wifi_sta_stop(void)
{
    if (!s_started) return;
    esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_h_wifi);
    esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, s_h_ip);
    esp_wifi_disconnect();
    esp_wifi_stop();
    esp_wifi_deinit();
    s_started = false;
}
