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

// Sendet ein ESP3 COMMON_COMMAND (Pakettyp 0x05) an den TCM515 und wartet auf
// den naechsten RESPONSE-Frame (Pakettyp 0x02). `cmd`/`cmd_len` ist NUR das
// Daten-Feld (z.B. {0x08} fuer CO_RD_IDBASE); Sync/Header/CRC baut die Funktion.
// Der komplette Antwort-Frame (inkl. Sync..CRC) wird nach `resp` kopiert.
// Serialisiert intern (nur ein Kommando gleichzeitig). Rueckgabe ESP_OK,
// ESP_ERR_TIMEOUT, o.ae.
esp_err_t enocean_uart_command(const uint8_t *cmd, size_t cmd_len,
                               uint8_t *resp, size_t resp_cap, size_t *resp_len,
                               int timeout_ms);

// Statistik. Werte sind kumulativ seit Boot.
uint64_t enocean_uart_rx_bytes(void);
uint64_t enocean_uart_tx_bytes(void);
uint32_t enocean_uart_rx_frames(void);
uint32_t enocean_uart_tx_frames(void);
