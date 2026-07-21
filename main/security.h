#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

// Fuellt buf mit zufaelligen Bytes aus einem starken RNG (HW-RNG des ESP32).
void sec_random_bytes(uint8_t *buf, size_t len);

// Erzeugt ein menschenlesbares Passwort aus einem Alphabet ohne
// verwechselbare Zeichen (0/O, 1/l/I). Laenge inklusive NUL <= out_size.
// out muss mind. 13 Byte gross sein fuer 12-stellige Passwoerter.
void sec_random_password(char *out, size_t out_size, size_t len);

// Erzeugt einen 32-stelligen hex-Token (128 bit Entropie) inkl. NUL.
// out muss mind. 33 Byte gross sein.
void sec_random_token(char *out, size_t out_size);

// Constant-time-Vergleich. Rueckgabe true wenn a und b identisch sind.
bool sec_constant_time_equal(const char *a, const char *b);

// Wrapper fuer strukturiertes Security-Event-Log (loggt auf INFO/WARN).
// Bewusst nicht als esp_log-Tag definiert, damit CRA/RED-Audits die
// Events leicht per "SEC:" grep-en koennen.
void sec_event(const char *event, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
