#pragma once

#include <stddef.h>
#include <stdint.h>

// Zentrale Telegramm-Telemetrie: parst die Roh-RX-Bytes vom TCM515 in
// vollstaendige ESP3-RADIO-Frames, haelt einen Ring der letzten Telegramme
// (fuer GET /api/telegrams) und ruft optional einen Callback pro Frame
// (Callback aktuell ungenutzt).

typedef void (*telemetry_frame_cb_t)(const uint8_t *frame, size_t len, void *user);

void telemetry_init(void);

// Mit den Roh-RX-Bytes vom TCM515 fuettern (aus dem RX-Fanout in mode_mgr).
void telemetry_feed_rx(const uint8_t *data, size_t len);

// Genau ein Callback, der bei jedem vollstaendigen RADIO_ERP1-Frame feuert.
void telemetry_set_frame_cb(telemetry_frame_cb_t cb, void *user);

// JSON-Array der letzten empfangenen Telegramme -> out. Rueckgabe: Bytes (ohne
// NUL) oder <0 bei Fehler.
int telemetry_dump_json(char *out, size_t out_size);

// Ein einzelner ESP3-Frame als JSON-Objekt (rorg, sender, data, dbm, raw, ts).
// Rueckgabe: geschriebene Bytes (ohne NUL), 0 wenn kein RADIO_ERP1-Frame.
int telemetry_frame_to_json(const uint8_t *frame, size_t len,
                            char *out, size_t out_size);
