#include "mode_mgr.h"
#include "config_store.h"
#include "security.h"
#include "board_config.h"

#include "enocean_uart.h"
#include "usb_cdc_gateway.h"
#include "wifi_sta.h"
#include "wifi_ap.h"
#include "captive_dns.h"
#include "tcp_server.h"
#include "http_portal.h"
#include "console_log.h"
#include "event_log.h"
#include "telemetry.h"

#include <string.h>
#include <stdio.h>

#include "esp_netif.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_sntp.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "mdns.h"
#include "lwip/sockets.h"

#include <time.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "eul-mgr";

// -----------------------------------------------------------------------------
// RX-Fanout: TCM515 -> alle aktiven Sinks (USB + alle TCP-Clients)
// -----------------------------------------------------------------------------
static void on_uart_rx(const uint8_t *data, size_t len, void *user)
{
    (void)user;
    usb_cdc_gateway_broadcast(data, len);
    tcp_server_broadcast(data, len);
    telemetry_feed_rx(data, len);   // ESP3-Parser fuer /api/telegrams
}

// -----------------------------------------------------------------------------
// Reboot-Scheduler fuer das HTTP-Portal (verhindert Restart mitten in der
// HTTP-Response).
// -----------------------------------------------------------------------------
static void reboot_task(void *arg)
{
    int delay_ms = (int)(intptr_t)arg;
    vTaskDelay(pdMS_TO_TICKS(delay_ms));
    esp_restart();
}

void mode_mgr_schedule_reboot(int delay_ms)
{
    xTaskCreate(reboot_task, "eul-reboot", 2048, (void *)(intptr_t)delay_ms, 3, NULL);
}

// Baut aus dem (freien) Geraetenamen einen gueltigen mDNS-Hostnamen:
// kleingeschrieben, nur [a-z0-9-], Rest zu '-' zusammengefasst, ohne Rand-'-'.
static void sanitize_hostname(const char *in, char *out, size_t cap)
{
    size_t j = 0;
    bool prev_dash = false;
    for (size_t i = 0; in && in[i] && j + 1 < cap; i++) {
        char c = in[i];
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
            out[j++] = c; prev_dash = false;
        } else if (j > 0 && !prev_dash) {
            out[j++] = '-'; prev_dash = true;
        }
    }
    while (j > 0 && out[j - 1] == '-') j--;
    out[j] = '\0';
}

// -----------------------------------------------------------------------------
// mDNS im Normal-Modus. Hostname wird aus dem Geraetenamen abgeleitet
// (Fallback: eul-gateway-<suffix>).
// -----------------------------------------------------------------------------
static void mdns_up(uint16_t tcp_port, bool tcp_enabled, const char *device_name)
{
    char host[48];
    sanitize_hostname(device_name ? device_name : "", host, sizeof(host));
    if (!host[0]) {
        snprintf(host, sizeof(host), "%s-%s",
                 CONFIG_EUL_MDNS_HOSTNAME_PREFIX, config_device_suffix());
    }

    if (mdns_init() != ESP_OK) return;
    mdns_hostname_set(host);
    mdns_instance_name_set((device_name && device_name[0]) ? device_name
                                                           : "Busware EUL22 EnOcean Gateway");
    if (tcp_enabled) {
        mdns_service_add(NULL, "_enocean", "_tcp", tcp_port, NULL, 0);
        mdns_txt_item_t txt[] = {
            { "proto", "esp3" },
            { "baud",  "57600" },
        };
        mdns_service_txt_set("_enocean", "_tcp", txt, 2);
    }
    // Portal ueber mDNS auch findbar
    mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    ESP_LOGI(TAG, "mdns: %s.local", host);
}

// -----------------------------------------------------------------------------
// Provisioning-Modus: SoftAP + Captive DNS + Portal
// -----------------------------------------------------------------------------
static eul_config_t s_prov_cfg;   // fuer den Beacon-Task (Stackframe waere weg)

static void prov_beacon_task(void *arg)
{
    // USB-Serial/JTAG puffert erst wenn ein Host lauscht; deswegen alle 5 s
    // die Credentials rausschreiben, damit man sie zuverlaessig faengt egal
    // wann der Serial-Monitor gestartet wird.
    while (1) {
        printf("\n=== EUL22 Provisioning ===\n");
        printf("SoftAP SSID : %s-%s\n",
               CONFIG_EUL_AP_SSID_PREFIX, config_device_suffix());
        printf("SoftAP Pass : %s\n", s_prov_cfg.ap_pass);
        printf("Portal-URL  : http://192.168.4.1/\n");
        printf("Admin User  : admin\n");
        printf("Admin Pass  : %s\n", s_prov_cfg.admin_pass);
        printf("TCP Token   : %s\n", s_prov_cfg.tcp_token);
        printf("==========================\n");
        fflush(stdout);
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

static void run_provisioning(const eul_config_t *cfg)
{
    memcpy(&s_prov_cfg, cfg, sizeof(s_prov_cfg));

    ESP_ERROR_CHECK(wifi_ap_start(cfg->ap_pass));
    ESP_ERROR_CHECK(captive_dns_start("192.168.4.1"));
    ESP_ERROR_CHECK(http_portal_start(true));
    xTaskCreate(prov_beacon_task, "eul-prov-beacon", 3072, NULL, 3, NULL);
}

// -----------------------------------------------------------------------------
// Zeit per SNTP holen (nur Normalmodus, WiFi steht). Zeitzone Europe/Berlin
// inkl. Sommerzeit, damit die Telegramme im Portal die echte Uhrzeit zeigen.
// -----------------------------------------------------------------------------
static void time_sync_start(const char *server, const char *tz)
{
    // SNTP haelt den Server-Zeiger, daher in einen statischen Puffer kopieren.
    static char s_ntp[EUL_NTP_MAX];
    snprintf(s_ntp, sizeof(s_ntp), "%s", (server && server[0]) ? server : "pool.ntp.org");

    setenv("TZ", (tz && tz[0]) ? tz : "CET-1CEST,M3.5.0,M10.5.0/3", 1);
    tzset();
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, s_ntp);
    esp_sntp_init();
    ESP_LOGI(TAG, "sntp gestartet (%s), TZ=%s", s_ntp, (tz && tz[0]) ? tz : "default");
}

// -----------------------------------------------------------------------------
// Periodischer Netz-Tick (30s): kleiner UDP-Broadcast-Keepalive, damit das
// FritzBox-Mesh/der Switch die MAC des Dongles in der Forwarding-Tabelle haelt
// (Mitigation gegen zeitweise L2-Unerreichbarkeit hinter dem Repeater). Alle
// ~120s zusaetzlich ein Netz-Status ins Event-Log (RSSI/IP/Clients).
// -----------------------------------------------------------------------------
static int s_ka_sock = -1;

static void net_tick(void *arg)
{
    (void)arg;
    static int cnt = 0;

    if (s_ka_sock < 0) {
        s_ka_sock = socket(AF_INET, SOCK_DGRAM, 0);
        if (s_ka_sock >= 0) {
            int yes = 1;
            setsockopt(s_ka_sock, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
        }
    }
    if (s_ka_sock >= 0) {
        // Ziel bevorzugt das Default-Gateway (unicast) - erzeugt Traffic ueber
        // die Mesh-Uplink-Strecke und haelt den Reverse-Path/die MAC eher aktiv
        // als ein reiner Broadcast. Fallback: limitierter Broadcast.
        uint32_t dst = htonl(INADDR_BROADCAST);
        esp_netif_t *nif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        esp_netif_ip_info_t ip;
        if (nif && esp_netif_get_ip_info(nif, &ip) == ESP_OK && ip.gw.addr) {
            dst = ip.gw.addr;
        }
        struct sockaddr_in a = {
            .sin_family = AF_INET,
            .sin_port = htons(9),                    // discard-Port
            .sin_addr.s_addr = dst,
        };
        static const char ka[] = "EUL22-keepalive";
        sendto(s_ka_sock, ka, sizeof(ka) - 1, 0, (struct sockaddr *)&a, sizeof(a));
    }
    if (++cnt >= 8) {   // alle ~120s (Tick 15s) Netz-Status ins Event-Log
        cnt = 0;
        int rssi = 0;
        esp_wifi_sta_get_rssi(&rssi);
        EVT_INFO("net", "status rssi=%d dBm ip=%s clients=%d heap=%u",
                 rssi, wifi_sta_ip_str() ? wifi_sta_ip_str() : "-",
                 tcp_server_active_clients(),
                 (unsigned)esp_get_free_heap_size());
    }
}

// -----------------------------------------------------------------------------
// Normalmodus: WiFi-STA, optional TCP-Server, optional USB-CDC
// -----------------------------------------------------------------------------
static void run_normal(const eul_config_t *cfg)
{
    // Wenn WiFi konfiguriert ist, aufbauen. Kommt nichts hoch -> fallback in
    // Provisioning-Modus.
    esp_err_t r = wifi_sta_start_and_wait(cfg->wifi_ssid, cfg->wifi_pass,
                                          pdMS_TO_TICKS(30000));
    if (r != ESP_OK) {
        sec_event("wifi_fallback", "STA connect failed -> provisioning");
        wifi_sta_stop();
        run_provisioning(cfg);
        return;
    }

    mdns_up(cfg->tcp_port, cfg->tcp_enabled, cfg->device_name);
    time_sync_start(cfg->ntp_server, cfg->tz);

    if (cfg->tcp_enabled) {
        ESP_ERROR_CHECK(tcp_server_start(cfg->tcp_port,
                                          cfg->tcp_auth_required,
                                          cfg->tcp_token));
    }

    // HTTP-Portal auch im Normalmodus verfuegbar (mit Basic Auth), damit man
    // ohne Factory-Reset umkonfigurieren kann.
    ESP_ERROR_CHECK(http_portal_start(false));

    // USB CDC bewusst zuletzt: sobald aktiv, wird esp_log stumm geschaltet.
    if (cfg->usb_enabled) {
        ESP_ERROR_CHECK(usb_cdc_gateway_start());
    }

    ESP_LOGI(TAG, "gateway up - ip=%s tcp=%s(auth=%s) usb=%s heap=%u",
             wifi_sta_ip_str() ? wifi_sta_ip_str() : "?",
             cfg->tcp_enabled ? "on"  : "off",
             cfg->tcp_auth_required ? "on" : "off",
             cfg->usb_enabled ? "on"  : "off",
             (unsigned)esp_get_free_heap_size());

    const esp_timer_create_args_t net_ta = { .callback = net_tick, .name = "eul-net" };
    esp_timer_handle_t net_th;
    if (esp_timer_create(&net_ta, &net_th) == ESP_OK)
        esp_timer_start_periodic(net_th, 15ULL * 1000000ULL);
}

esp_err_t mode_mgr_start(void)
{
    // NVS zuerst - config_store braucht ihn.
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        r = nvs_flash_init();
    }
    ESP_ERROR_CHECK(r);

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    console_log_init();
    event_log_init();
    telemetry_init();
    EVT_INFO("boot", "Busware EUL22 Firmware gestartet");

    eul_config_t cfg;
    ESP_ERROR_CHECK(config_load(&cfg));

    // TCM515 in JEDEM Modus hochfahren (spart Zeit, wenn Provisioning schnell
    // durchlaeuft) und Broadcast-Callback binden.
    ESP_ERROR_CHECK(enocean_uart_start());
    enocean_uart_set_rx_cb(on_uart_rx, NULL);

    if (!cfg.provisioned) {
        ESP_LOGI(TAG, "no config -> provisioning mode");
        run_provisioning(&cfg);
    } else {
        ESP_LOGI(TAG, "provisioned config found -> normal mode");
        run_normal(&cfg);
    }

    return ESP_OK;
}
