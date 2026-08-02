#pragma once

#include <stddef.h>
#include <stdint.h>

// Zentrale Telegramm-Telemetrie: parst die Roh-RX-Bytes vom TCM515 in
// vollstaendige ESP3-Frames, haelt einen Ringpuffer der letzten Telegramme
// (beide Richtungen) und ruft optional einen Callback pro RADIO-Frame
// (Callback aktuell ungenutzt).
//
// Der Ring ist die EINZIGE Quelle der Telegramm-Tabelle im Portal: die
// Statusseite holt ihn ueber GET /api/telegrams?since=<seq> inkrementell ab.
// Vorher wurden die Telegramme aus dem Konsolen-Stream rekonstruiert - dort
// teilten sie sich den Ring mit Logzeilen, wurden auf die Zeilenlaenge gekappt
// und waren nach einem Reload des Portals groesstenteils weg.

#define EUL_TEL_RING       100   // sichtbare Historie (siehe Portal-Statusseite)
// Groesster Frame, den wir aufheben. Deckt jedes ERP1-Funktelegramm ab (RORG
// + max. 14 Byte VLD-Nutzdaten + 4 Byte Sender + Status + 7 Byte optional =
// unter 40). Der ESP3-Parser laesst bis EUL_ESP3_MAX_FRAME durch; was hier
// nicht reinpasst (verkettete / Remote-Management-Frames) landet nicht im Ring
// - halb gespeichert waere es nicht dekodierbar. In der Konsole ist es
// weiterhin zu sehen.
#define EUL_TEL_FRAME_MAX  96

typedef void (*telemetry_frame_cb_t)(const uint8_t *frame, size_t len, void *user);

void telemetry_init(void);

// Mit den Roh-RX-Bytes vom TCM515 fuettern (aus dem RX-Fanout in mode_mgr).
void telemetry_feed_rx(const uint8_t *data, size_t len);

// Einen an den TCM515 gesendeten Frame in den Ring aufnehmen. Wird an
// denselben Stellen aufgerufen wie console_log_frame_from(), damit die
// Sende-Richtung in der Telegramm-Tabelle genauso sichtbar ist.
void telemetry_note_tx(const uint8_t *frame, size_t len);

// Genau ein Callback, der bei jedem vollstaendigen RADIO_ERP1-Frame feuert.
void telemetry_set_frame_cb(telemetry_frame_cb_t cb, void *user);

// Senke fuer den Streaming-Dump. Rueckgabe 0 = ok, <0 = abbrechen.
typedef int (*telemetry_emit_t)(void *user, const char *chunk, size_t len);

// JSON-Array aller Ring-Eintraege mit seq > since_seq, aelteste zuerst, in
// Haeppchen an emit(). Gestreamt statt in einen Puffer, weil der volle Ring
// (100 Eintraege) sonst einen ~30 KB grossen Zwischenpuffer braeuchte.
// Rueckgabe: 0 bei Erfolg, <0 wenn die Senke abgebrochen hat.
int telemetry_dump_json_stream(uint64_t since_seq, telemetry_emit_t emit, void *user);

// Ein einzelner ESP3-Frame als JSON-Objekt (seq/dir sind dabei 0 bzw. "rx").
// Rueckgabe: geschriebene Bytes (ohne NUL), 0 wenn nicht formatierbar.
int telemetry_frame_to_json(const uint8_t *frame, size_t len,
                            char *out, size_t out_size);
