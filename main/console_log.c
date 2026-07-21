#include "console_log.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_timer.h"

typedef struct {
    uint64_t seq;         // 0 = leer
    int64_t  ts_us;
    char     line[EUL_CONSOLE_LINE_MAX];
} entry_t;

static entry_t s_ring[EUL_CONSOLE_RING_SIZE];
static int      s_head       = 0;   // naechste freie Position
static uint64_t s_next_seq   = 1;
static SemaphoreHandle_t s_mtx;

void console_log_init(void)
{
    if (s_mtx) return;
    s_mtx = xSemaphoreCreateMutex();
    memset(s_ring, 0, sizeof(s_ring));
}

static void push_line(const char *line)
{
    if (!s_mtx) return;
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    entry_t *e = &s_ring[s_head];
    e->seq   = s_next_seq++;
    e->ts_us = esp_timer_get_time();
    strncpy(e->line, line, sizeof(e->line) - 1);
    e->line[sizeof(e->line) - 1] = '\0';
    s_head = (s_head + 1) % EUL_CONSOLE_RING_SIZE;
    xSemaphoreGive(s_mtx);
}

void console_logf(const char *fmt, ...)
{
    char buf[EUL_CONSOLE_LINE_MAX];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    push_line(buf);
}

static void hex_line(char *out, size_t out_size,
                     const char *prefix,
                     const uint8_t *data, size_t len)
{
    // Sicherheit: kappen auf so viele Bytes wie ins Zielformat passen.
    // 3 Zeichen pro Byte ("aa ") plus Prefix + " ..." Suffix.
    size_t pos = 0;
    int n = snprintf(out + pos, out_size - pos, "%s", prefix);
    if (n < 0) return;
    pos += (size_t)n;

    size_t max_bytes = (out_size > pos + 8) ? (out_size - pos - 8) / 3 : 0;
    size_t shown = len < max_bytes ? len : max_bytes;
    for (size_t i = 0; i < shown; i++) {
        n = snprintf(out + pos, out_size - pos, "%02x ", data[i]);
        if (n < 0 || (size_t)n >= out_size - pos) break;
        pos += (size_t)n;
    }
    if (shown < len) {
        snprintf(out + pos, out_size - pos, "... (%uB)", (unsigned)len);
    } else {
        snprintf(out + pos, out_size - pos, "(%uB)", (unsigned)len);
    }
}

void console_log_frame_from(const char *peer, const uint8_t *frame, size_t len)
{
    char prefix[48];
    snprintf(prefix, sizeof(prefix), "> %-21s : ", peer ? peer : "?");
    char line[EUL_CONSOLE_LINE_MAX];
    hex_line(line, sizeof(line), prefix, frame, len);
    push_line(line);
}

void console_log_frame_tcm(const uint8_t *frame, size_t len)
{
    char line[EUL_CONSOLE_LINE_MAX];
    hex_line(line, sizeof(line), "< TCM                   : ", frame, len);
    push_line(line);
}

// JSON-Encoder fuer eine Zeichenkette (ohne " am Anfang/Ende). Escapet \" \\ \n \r \t
static size_t append_json_str(char *out, size_t cap, const char *s)
{
    size_t p = 0;
    for (; *s && p + 6 < cap; s++) {
        char c = *s;
        if (c == '"' || c == '\\') {
            if (p + 2 >= cap) break;
            out[p++] = '\\'; out[p++] = c;
        } else if (c == '\n') { out[p++] = '\\'; out[p++] = 'n'; }
        else if (c == '\r') { out[p++] = '\\'; out[p++] = 'r'; }
        else if (c == '\t') { out[p++] = '\\'; out[p++] = 't'; }
        else if ((unsigned char)c < 0x20) {
            int n = snprintf(out + p, cap - p, "\\u%04x", c);
            if (n < 0) break;
            p += (size_t)n;
        } else {
            out[p++] = c;
        }
    }
    return p;
}

int console_log_dump_since(uint64_t since_seq, char *buf, size_t buf_size,
                           uint64_t *last_seq)
{
    if (!s_mtx || !buf || buf_size < 4) return -1;

    size_t p = 0;
    buf[p++] = '{';
    p += snprintf(buf + p, buf_size - p, "\"lines\":[");

    xSemaphoreTake(s_mtx, portMAX_DELAY);

    // Iteriere aelteste -> juengste. Platz fuer den Abschluss
    // "],\"last_seq\":<=20 stellig>}" reservieren, damit die Antwort bei vollem
    // Puffer NIE ungueltig wird: passt eine Zeile nicht mehr komplett, brechen
    // wir sauber ab (Rollback) und liefern das gueltige last_seq der letzten
    // vollstaendig geschriebenen Zeile. Der Client holt den Rest im naechsten
    // Poll ab - kein -1/HTTP-500 mehr, das sonst den Cursor blockierte.
    bool first = true;
    uint64_t local_last = since_seq;
    const size_t reserve = 40;
    size_t limit = (buf_size > reserve) ? (buf_size - reserve) : 0;
    for (int i = 0; i < EUL_CONSOLE_RING_SIZE; i++) {
        int idx = (s_head + i) % EUL_CONSOLE_RING_SIZE;
        const entry_t *e = &s_ring[idx];
        if (e->seq == 0 || e->seq <= since_seq) continue;

        size_t start = p;   // Rollback-Punkt falls das Element nicht mehr passt
        if (!first) {
            if (p + 1 >= limit) break;
            buf[p++] = ',';
        }
        // Element: {"seq":N,"ms":M,"line":"..."}
        int n = snprintf(buf + p, buf_size - p,
                         "{\"seq\":%llu,\"ms\":%lld,\"line\":\"",
                         (unsigned long long)e->seq,
                         (long long)(e->ts_us / 1000));
        if (n < 0 || p + (size_t)n >= limit) { p = start; break; }
        p += (size_t)n;
        p += append_json_str(buf + p, limit - p, e->line);
        if (p + 2 >= limit) { p = start; break; }
        buf[p++] = '"';
        buf[p++] = '}';
        first = false;
        local_last = e->seq;
    }

    xSemaphoreGive(s_mtx);

    p += snprintf(buf + p, buf_size - p,
                  "],\"last_seq\":%llu}", (unsigned long long)local_last);

    if (last_seq) *last_seq = local_last;
    return (int)p;
}
