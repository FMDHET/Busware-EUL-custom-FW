#pragma once

#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

// Init + Reset des TCM515 und UART0-Setup.
esp_err_t enocean_uart_start(void);

// Sperrt die UART fuer den Aufrufer und schreibt `frame`/`len` atomar raus.
// Fuer TX aus verschiedenen TCP-Clients: nur *komplette* ESP3-Frames schreiben.
esp_err_t enocean_uart_write_frame(const uint8_t *frame, size_t len);

// Registriert einen Callback, der von der internen RX-Task fuer JEDES Byte
// gerufen wird, das von der TCM515 kommt. Der TCP-Server benutzt das um an
// alle Clients zu broadcasten. Nur EIN Callback global.
typedef void (*enocean_rx_cb_t)(const uint8_t *data, size_t len, void *user);
void enocean_uart_set_rx_cb(enocean_rx_cb_t cb, void *user);

// Statistik. Werte sind kumulativ seit Boot.
uint64_t enocean_uart_rx_bytes(void);
uint64_t enocean_uart_tx_bytes(void);
uint32_t enocean_uart_rx_frames(void);
uint32_t enocean_uart_tx_frames(void);
