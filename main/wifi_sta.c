#include "wifi_sta.h"
#include "security.h"
#include "event_log.h"
#include "sdkconfig.h"

#include <string.h>

#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

static const char *TAG = "eul-sta";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1

// Reconnect-Backoff: nach einer Trennung NICHT in Dauerschleife sofort neu
// verbinden (das thrasht den Supplicant), sondern mit wachsendem Abstand.
#define WIFI_RECONNECT_MIN_MS   500
#define WIFI_RECONNECT_MAX_MS  5000
// So viele AUFEINANDERFOLGENDE Auth-Fehler beim ALLERERSTEN Verbinden (noch nie
// eine IP gehabt) werten wir als "Zugangsdaten falsch" -> Rueckfall ins
// Provisioning. Ein bloss abwesender Router (NO_AP_FOUND) zaehlt hier NICHT mit.
#define WIFI_AUTH_FAIL_LIMIT     5

static EventGroupHandle_t s_wifi_evt;
static char s_ip[16];
static bool s_started = false;
static bool s_ever_connected = false;   // true, sobald wir einmal eine IP hatten
static bool s_use_static = false;       // feste IP aktiv?
static char s_static_ip_str[16];        // fuer die Anzeige bei fester IP
static esp_event_handler_instance_t s_h_wifi, s_h_ip;
static esp_timer_handle_t s_reconnect_timer;
static int      s_auth_fails = 0;        // aufeinanderfolgende Auth-Fehler (Boot)
static uint32_t s_backoff_ms = WIFI_RECONNECT_MIN_MS;

static void reconnect_cb(void *arg)
{
    (void)arg;
    esp_wifi_connect();
}

// Verbindungsversuch mit Backoff planen. Laeuft im esp_timer-Task, NICHT im
// WiFi-Event-Task -> blockiert das Event-Handling nicht und vermeidet den
// vTaskDelay-im-Callback-Fehler.
static void schedule_reconnect(void)
{
    if (!s_reconnect_timer) { esp_wifi_connect(); return; }
    esp_timer_stop(s_reconnect_timer);   // evtl. laufenden Timer neu aufziehen
    esp_timer_start_once(s_reconnect_timer, (uint64_t)s_backoff_ms * 1000);
    uint32_t next = s_backoff_ms * 2;
    s_backoff_ms = (next > WIFI_RECONNECT_MAX_MS) ? WIFI_RECONNECT_MAX_MS : next;
}

// Trennungsgruende, die auf FALSCHE Zugangsdaten hindeuten (nicht auf einen
// bloss noch abwesenden AP). Nur diese fuehren beim Erstverbinden ins
// Provisioning zurueck.
static bool reason_is_auth(uint16_t reason)
{
    switch (reason) {
        case WIFI_REASON_AUTH_FAIL:               // 202
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:  // 15
        case WIFI_REASON_HANDSHAKE_TIMEOUT:       // 204
        case WIFI_REASON_MIC_FAILURE:             // 14
            return true;
        default:
            return false;
    }
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        s_backoff_ms = WIFI_RECONNECT_MIN_MS;
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        // Bei fester IP feuert IP_EVENT_STA_GOT_IP nicht zuverlaessig - darum
        // hier die Verbindung als "up" melden.
        if (s_use_static) {
            snprintf(s_ip, sizeof(s_ip), "%s", s_static_ip_str);
            int rssi = 0;
            esp_wifi_sta_get_rssi(&rssi);
            EVT_INFO("wifi", "verbunden, feste IP %s (rssi %d dBm)", s_ip, rssi);
            s_auth_fails = 0;
            s_backoff_ms = WIFI_RECONNECT_MIN_MS;
            s_ever_connected = true;
            xEventGroupSetBits(s_wifi_evt, WIFI_CONNECTED_BIT);
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = (wifi_event_sta_disconnected_t *)data;
        s_ip[0] = '\0';
        xEventGroupClearBits(s_wifi_evt, WIFI_CONNECTED_BIT);
        EVT_WARN("wifi", "getrennt (reason=%d)", e->reason);

        if (s_ever_connected) {
            // Laufzeit-Drop nach schon erfolgreicher Verbindung: NIE aufgeben.
            // Der alte WIFI_MAX_RETRY-Deckel liess das Gateway nach einem
            // WLAN-Schluckauf tot liegen (bis Power-Cycle) - genau die Ursache
            // der zeitweisen Unerreichbarkeit / fehlenden Feedback-Telegramme.
            ESP_LOGW(TAG, "disconnected reason=%d, reconnect in %ums (runtime)",
                     e->reason, (unsigned)s_backoff_ms);
            schedule_reconnect();
        } else if (reason_is_auth(e->reason)) {
            // Erstverbindung UND Auth-Fehler -> vermutlich falsches Passwort.
            // Erst nach mehreren aufeinanderfolgenden Auth-Fehlern aufgeben,
            // damit ein einzelner Handshake-Timeout auf verrauschtem Kanal
            // nicht sofort ins Provisioning kippt.
            s_auth_fails++;
            if (s_auth_fails >= WIFI_AUTH_FAIL_LIMIT) {
                sec_event("wifi_connect_fail",
                          "auth failed %dx (last reason=%d) -> provisioning",
                          s_auth_fails, e->reason);
                xEventGroupSetBits(s_wifi_evt, WIFI_FAIL_BIT);
            } else {
                ESP_LOGW(TAG, "auth fail %d/%d (reason=%d), retry",
                         s_auth_fails, WIFI_AUTH_FAIL_LIMIT, e->reason);
                schedule_reconnect();
            }
        } else {
            // Erstverbindung, aber KEIN Auth-Fehler (typisch NO_AP_FOUND: der
            // Router ist z.B. nach einem Stromausfall noch nicht wieder da).
            // Ein LAN-Gateway darf deswegen NICHT in den AP-Modus kippen -
            // sonst ist es im Netz unsichtbar. Also geduldig weiter versuchen.
            ESP_LOGW(TAG, "no AP yet (reason=%d), retry in %ums",
                     e->reason, (unsigned)s_backoff_ms);
            schedule_reconnect();
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&e->ip_info.ip));
        ESP_LOGI(TAG, "got ip: %s", s_ip);
        int rssi = 0;
        esp_wifi_sta_get_rssi(&rssi);
        EVT_INFO("wifi", "verbunden, IP %s (rssi %d dBm)", s_ip, rssi);
        s_auth_fails = 0;
        s_backoff_ms = WIFI_RECONNECT_MIN_MS;
        s_ever_connected = true;
        xEventGroupSetBits(s_wifi_evt, WIFI_CONNECTED_BIT);
    }
}

esp_err_t wifi_sta_start_and_wait(const char *ssid, const char *pass,
                                  const wifi_static_ip_t *sip, TickType_t timeout)
{
    if (!ssid || !ssid[0]) return ESP_ERR_INVALID_ARG;

    s_wifi_evt = xEventGroupCreate();
    s_auth_fails = 0;
    s_backoff_ms = WIFI_RECONNECT_MIN_MS;
    if (!s_reconnect_timer) {
        const esp_timer_create_args_t rta = {
            .callback = reconnect_cb, .name = "eul-wifi-rc"
        };
        esp_timer_create(&rta, &s_reconnect_timer);
    }

    // Netif + Event Loop erwarten wir bereits initialisiert (in mode_mgr).
    // Idempotent: bei einem STA<->AP-Wechsel existiert die Netif ggf. schon.
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (!netif) netif = esp_netif_create_default_wifi_sta();

    // Feste IP (optional): DHCP-Client stoppen, statische Adresse + DNS setzen.
    s_use_static = false;
    if (sip && sip->enabled && sip->ip && sip->ip[0]) {
        esp_netif_dhcpc_stop(netif);
        esp_netif_ip_info_t ipi = { 0 };
        ipi.ip.addr      = esp_ip4addr_aton(sip->ip);
        ipi.gw.addr      = (sip->gw && sip->gw[0]) ? esp_ip4addr_aton(sip->gw) : 0;
        ipi.netmask.addr = (sip->mask && sip->mask[0]) ? esp_ip4addr_aton(sip->mask)
                                                       : esp_ip4addr_aton("255.255.255.0");
        esp_netif_set_ip_info(netif, &ipi);
        if (sip->dns && sip->dns[0]) {
            esp_netif_dns_info_t dns = { 0 };
            dns.ip.type = ESP_IPADDR_TYPE_V4;
            dns.ip.u_addr.ip4.addr = esp_ip4addr_aton(sip->dns);
            esp_netif_set_dns_info(netif, ESP_NETIF_DNS_MAIN, &dns);
        }
        s_use_static = true;
        snprintf(s_static_ip_str, sizeof(s_static_ip_str), "%s", sip->ip);
        ESP_LOGI(TAG, "feste IP %s gw %s", sip->ip, sip->gw ? sip->gw : "-");
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
    // 802.11k/v/MBO aktivieren (Support in sdkconfig): damit kann das FritzBox-
    // Mesh den Client per BSS Transition Management sauber steuern/uebergeben,
    // statt ihn hinter Repeatern zeitweise L2-unerreichbar zu lassen.
    wc.sta.rm_enabled  = 1;   // 802.11k (Radio Measurement)
    wc.sta.btm_enabled = 1;   // 802.11v (BSS Transition Management)
    wc.sta.mbo_enabled = 1;   // MBO
    // Unter einer Mesh-SSID (mehrere FRITZ!Box-/Repeater-Knoten) beim Verbinden
    // den STAERKSTEN AP nehmen (Default Fast-Scan = erster Treffer). Kein RSSI-
    // Threshold, damit er sich zur Not auch an einem schwachen AP verbindet.
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

esp_err_t wifi_sta_wait_connected(TickType_t timeout)
{
    if (!s_wifi_evt) return ESP_ERR_INVALID_STATE;
    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_evt, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT, pdFALSE, pdFALSE, timeout);
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
    // Zuerst den Reconnect-Timer stoppen, damit reconnect_cb NICHT nach dem
    // esp_wifi_deinit() noch esp_wifi_connect() aufruft (Crash).
    if (s_reconnect_timer) esp_timer_stop(s_reconnect_timer);
    esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_h_wifi);
    esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, s_h_ip);
    esp_wifi_disconnect();
    esp_wifi_stop();
    esp_wifi_deinit();
    s_started = false;
}
