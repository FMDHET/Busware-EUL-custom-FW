#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

// Startet den TCP-Server. auth_required=true erzwingt AUTH-Handshake per
// Token vor der ESP3-Bridge-Phase (CRA "secure by default"). Der token-Zeiger
// muss lebenslang gueltig bleiben (kommt aus dem persistenten config_store).
esp_err_t tcp_server_start(uint16_t port, bool auth_required, const char *token);

void tcp_server_broadcast(const uint8_t *data, size_t len);
int  tcp_server_active_clients(void);

// Schreibt ein JSON-Array der aktuell verbundenen Clients in `out`.
// Format: [{"peer":"...","connected_ms":...,"rx_bytes":...,"tx_bytes":...,"rx_frames":...}, ...]
// Rueckgabe: geschriebene Byte-Anzahl ohne NUL, oder -1 bei Fehler.
int tcp_server_dump_clients_json(char *out, size_t out_size);
