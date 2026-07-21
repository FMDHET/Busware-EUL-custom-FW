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
#include "telemetry.h"
#include "mqtt_bridge.h"

#include <string.h>
#include <stdio.h>

#include "esp_netif.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_sntp.h"
#include "nvs_flash.h"
#include "mdns.h"

#include <time.h>
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
    telemetry_feed_rx(data, len);   // ESP3-Parser fuer /api/telegrams + MQTT
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

// -----------------------------------------------------------------------------
// mDNS im Normal-Modus
// -----------------------------------------------------------------------------
static void mdns_up(uint16_t tcp_port, bool tcp_enabled)
{
    char host[48];
    snprintf(host, sizeof(host), "%s-%s",
             CONFIG_EUL_MDNS_HOSTNAME_PREFIX, config_device_suffix());

    if (mdns_init() != ESP_OK) return;
    mdns_hostname_set(host);
    mdns_instance_name_set("Busware EUL22 EnOcean Gateway");
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
static void time_sync_start(void)
{
    setenv("TZ", "CET-1CEST,M3.5.0,M10.5.0/3", 1);
    tzset();
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "pool.ntp.org");
    esp_sntp_init();
    ESP_LOGI(TAG, "sntp gestartet (pool.ntp.org), TZ=Europe/Berlin");
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

    mdns_up(cfg->tcp_port, cfg->tcp_enabled);
    time_sync_start();

    if (cfg->tcp_enabled) {
        ESP_ERROR_CHECK(tcp_server_start(cfg->tcp_port,
                                          cfg->tcp_auth_required,
                                          cfg->tcp_token));
    }

    // HTTP-Portal auch im Normalmodus verfuegbar (mit Basic Auth), damit man
    // ohne Factory-Reset umkonfigurieren kann.
    ESP_ERROR_CHECK(http_portal_start(false));

    // MQTT-Bridge (optional): publish empfangene Telegramme, subscribe command.
    if (cfg->mqtt_enabled) {
        if (cfg->mqtt_topic[0]) {
            mqtt_bridge_start(cfg->mqtt_host, cfg->mqtt_port,
                              cfg->mqtt_user, cfg->mqtt_pass, cfg->mqtt_topic);
        } else {
            char topic[EUL_MQTT_TOPIC_MAX + 16];
            snprintf(topic, sizeof(topic), "eul22/%s", config_device_suffix());
            mqtt_bridge_start(cfg->mqtt_host, cfg->mqtt_port,
                              cfg->mqtt_user, cfg->mqtt_pass, topic);
        }
    }

    // USB CDC bewusst zuletzt: sobald aktiv, wird esp_log stumm geschaltet.
    if (cfg->usb_enabled) {
        ESP_ERROR_CHECK(usb_cdc_gateway_start());
    }

    ESP_LOGI(TAG, "gateway up - ip=%s tcp=%s(auth=%s) usb=%s",
             wifi_sta_ip_str() ? wifi_sta_ip_str() : "?",
             cfg->tcp_enabled ? "on"  : "off",
             cfg->tcp_auth_required ? "on" : "off",
             cfg->usb_enabled ? "on"  : "off");
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
    telemetry_init();

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
