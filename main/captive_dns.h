#pragma once

#include "esp_err.h"

// Startet einen minimalen DNS-Responder auf UDP/53, der ALLE A-Queries mit
// der AP-IP beantwortet. Fuer Captive-Portal-Erkennung durch Smartphones.
esp_err_t captive_dns_start(const char *ap_ip_str);
