#pragma once

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

// Verbindet WiFi im STA-Modus mit den uebergebenen Credentials und blockiert
// bis IP erhalten oder Timeout. Kein NVS-Zugriff hier - Config kommt von aussen.
esp_err_t wifi_sta_start_and_wait(const char *ssid, const char *pass, TickType_t timeout);

const char *wifi_sta_ip_str(void);

// Vollstaendig herunterfahren (fuer Wechsel STA->AP).
void wifi_sta_stop(void);
