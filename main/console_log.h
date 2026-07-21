#pragma once

#include <stddef.h>
#include <stdint.h>

// Zeilenbasierter Ring-Buffer fuer die Web-Konsole.
// Jeder Eintrag bekommt eine monoton wachsende Sequenznummer, damit das
// Frontend per "?since=<seq>" nur neue Zeilen abholt.

#define EUL_CONSOLE_LINE_MAX   160
#define EUL_CONSOLE_RING_SIZE  200

void console_log_init(void);

// Freies Formatstring-Log (printf-artig). Prefix und Zeitstempel werden
// automatisch ergaenzt.
void console_logf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

// Convenience: kompletter ESP3-Frame in Richtung TCM515 (aus TCP-Client).
void console_log_frame_from(const char *peer, const uint8_t *frame, size_t len);

// Convenience: kompletter ESP3-Frame vom TCM515.
void console_log_frame_tcm(const uint8_t *frame, size_t len);

// Fuellt buf mit einem JSON-Array der Zeilen mit seq > since_seq.
// last_seq wird auf die hoechste ausgegebene Seq gesetzt (oder unveraendert
// wenn keine neuen Zeilen).
// Rueckgabe: Anzahl Bytes geschrieben (ohne NUL) oder <0 bei Fehler.
int console_log_dump_since(uint64_t since_seq, char *buf, size_t buf_size,
                           uint64_t *last_seq);
