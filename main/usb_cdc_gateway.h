#pragma once

#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

// Startet die USB-CDC-Bridge (USB Serial/JTAG des ESP32-C3).
// Sobald aktiv: alle ESP-IDF-Logs werden per esp_log_level_set stumm geschaltet,
// weil sie sonst den binaeren ESP3-Bytestrom auf USB stoeren.
esp_err_t usb_cdc_gateway_start(void);

// Wird vom UART-RX-Fanout aufgerufen: reicht Bytes ans USB weiter.
// No-op falls Gateway nicht aktiv.
void usb_cdc_gateway_broadcast(const uint8_t *data, size_t len);
