#pragma once

#include "esp_err.h"

// Zentraler Boot-Orchestrator. Entscheidet basierend auf NVS-Config, ob wir
// in Provisioning (SoftAP + Captive Portal) oder Normal-Modus (WiFi STA,
// optional TCP-Bridge, optional USB-CDC-Bridge) starten.
esp_err_t mode_mgr_start(void);

// Wird vom HTTP-Portal aufgerufen, um nach einer Config-Aenderung geordnet
// neu zu starten (kurze Delay-Task, damit die HTTP-Antwort noch rausgeht).
void mode_mgr_schedule_reboot(int delay_ms);
