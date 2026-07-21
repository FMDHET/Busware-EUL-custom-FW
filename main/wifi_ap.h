#pragma once

#include "esp_err.h"

// Startet SoftAP mit SSID "<prefix>-<mac_suffix>" und der uebergebenen WPA2-
// Passphrase (>=8 Zeichen). Der AP haengt an 192.168.4.1 mit DHCP.
esp_err_t wifi_ap_start(const char *pass);

const char *wifi_ap_ssid(void);
const char *wifi_ap_ip_str(void);
