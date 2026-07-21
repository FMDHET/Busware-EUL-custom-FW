#pragma once

#include <stdbool.h>
#include "esp_err.h"

// Startet das HTTP-Portal.
//   ap_mode=true  -> keine Auth (AP ist per WPA2 geschuetzt, Provisioning-Fall)
//   ap_mode=false -> HTTP Basic Auth mit user 'admin' und admin-Passwort aus NVS
esp_err_t http_portal_start(bool ap_mode);
