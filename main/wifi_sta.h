#pragma once

#include <stdbool.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"

// Optionale feste IP (statt DHCP). enabled=false -> DHCP wie gehabt.
typedef struct {
    bool        enabled;
    const char *ip;
    const char *gw;
    const char *mask;
    const char *dns;
} wifi_static_ip_t;

// Verbindet WiFi im STA-Modus mit den uebergebenen Credentials und blockiert
// bis IP erhalten oder Timeout. Kein NVS-Zugriff hier - Config kommt von aussen.
// sip==NULL oder sip->enabled==false -> DHCP.
esp_err_t wifi_sta_start_and_wait(const char *ssid, const char *pass,
                                  const wifi_static_ip_t *sip, TickType_t timeout);

// Wartet erneut auf eine Verbindung, OHNE WiFi neu zu initialisieren (die STA
// versucht im Hintergrund mit Backoff weiter). Fuer geduldiges Warten beim Boot.
// ESP_OK = verbunden, ESP_FAIL = Zugangsdaten falsch, ESP_ERR_TIMEOUT = noch nicht.
esp_err_t wifi_sta_wait_connected(TickType_t timeout);

const char *wifi_sta_ip_str(void);

// Vollstaendig herunterfahren (fuer Wechsel STA->AP).
void wifi_sta_stop(void);
