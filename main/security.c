#include "security.h"

#include <string.h>
#include <stdarg.h>
#include <stdio.h>

#include "esp_random.h"
#include "esp_log.h"

// Alphabet ohne verwechselbare Zeichen (0/O, 1/l/I, 2/Z gedanklich).
static const char PW_ALPHABET[] =
    "ABCDEFGHJKLMNPQRSTUVWXYZ"    // no I, O
    "abcdefghijkmnpqrstuvwxyz"    // no l, o
    "23456789";                    // no 0, 1
static const size_t PW_ALPHABET_LEN = sizeof(PW_ALPHABET) - 1;

void sec_random_bytes(uint8_t *buf, size_t len)
{
    esp_fill_random(buf, len);
}

void sec_random_password(char *out, size_t out_size, size_t len)
{
    if (out_size == 0 || len == 0) return;
    if (len + 1 > out_size) len = out_size - 1;

    uint8_t tmp[64];
    if (len > sizeof(tmp)) len = sizeof(tmp);
    sec_random_bytes(tmp, len);
    for (size_t i = 0; i < len; i++) {
        out[i] = PW_ALPHABET[tmp[i] % PW_ALPHABET_LEN];
    }
    out[len] = '\0';
}

void sec_random_token(char *out, size_t out_size)
{
    if (out_size < 33) return;
    uint8_t raw[16];
    sec_random_bytes(raw, sizeof(raw));
    static const char HEX[] = "0123456789abcdef";
    for (int i = 0; i < 16; i++) {
        out[2*i]     = HEX[raw[i] >> 4];
        out[2*i + 1] = HEX[raw[i] & 0x0F];
    }
    out[32] = '\0';
}

bool sec_constant_time_equal(const char *a, const char *b)
{
    if (!a || !b) return false;
    size_t la = strlen(a);
    size_t lb = strlen(b);
    // Wir vergleichen ueber max(la, lb) Byte, um kein Timing-Signal ueber
    // die Laenge zu geben. Ungleiche Laenge -> Ergebnis in jedem Fall false.
    size_t n = la > lb ? la : lb;
    volatile uint8_t diff = (uint8_t)(la ^ lb);
    for (size_t i = 0; i < n; i++) {
        uint8_t ca = i < la ? (uint8_t)a[i] : 0;
        uint8_t cb = i < lb ? (uint8_t)b[i] : 0;
        diff |= (uint8_t)(ca ^ cb);
    }
    return diff == 0;
}

void sec_event(const char *event, const char *fmt, ...)
{
    char buf[192];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    ESP_LOGW("SEC", "%s: %s", event, buf);
}
