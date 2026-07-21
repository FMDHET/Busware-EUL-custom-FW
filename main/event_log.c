#include "event_log.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"

#define EVT_RING     120
#define EVT_MSG_MAX  120
#define EVT_TAG_MAX  12

typedef struct {
    uint64_t  seq;                 // 0 = leer
    int64_t   ts_us;               // Uptime
    long long epoch_ms;            // Echtzeit (0 = nicht sync)
    uint8_t   level;
    char      tag[EVT_TAG_MAX];
    char      msg[EVT_MSG_MAX];
} evt_t;

static evt_t             s_ring[EVT_RING];
static int               s_head;
static uint64_t          s_next_seq = 1;
static SemaphoreHandle_t s_mtx;

void event_log_init(void)
{
    if (s_mtx) return;
    s_mtx = xSemaphoreCreateMutex();
    memset(s_ring, 0, sizeof(s_ring));
}

void event_log_add(int level, const char *tag, const char *fmt, ...)
{
    char msg[EVT_MSG_MAX];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);

    // Spiegeln auf ESP_LOG (Serial ist immer verfuegbar).
    const char *t = tag ? tag : "evt";
    if (level >= EVT_LEVEL_ERR)       ESP_LOGE(t, "%s", msg);
    else if (level == EVT_LEVEL_WARN) ESP_LOGW(t, "%s", msg);
    else                              ESP_LOGI(t, "%s", msg);

    if (!s_mtx) return;

    struct timeval tv;
    gettimeofday(&tv, NULL);
    long long epoch = (tv.tv_sec > 1700000000LL)
        ? ((long long)tv.tv_sec * 1000 + tv.tv_usec / 1000) : 0;

    xSemaphoreTake(s_mtx, portMAX_DELAY);
    evt_t *e = &s_ring[s_head];
    e->seq      = s_next_seq++;
    e->ts_us    = esp_timer_get_time();
    e->epoch_ms = epoch;
    e->level    = (uint8_t)level;
    snprintf(e->tag, sizeof(e->tag), "%s", t);
    memcpy(e->msg, msg, sizeof(e->msg));
    e->msg[sizeof(e->msg) - 1] = '\0';
    s_head = (s_head + 1) % EVT_RING;
    xSemaphoreGive(s_mtx);
}

static size_t append_json_str(char *out, size_t cap, const char *s)
{
    size_t p = 0;
    for (; *s && p + 6 < cap; s++) {
        char c = *s;
        if (c == '"' || c == '\\') { if (p + 2 >= cap) break; out[p++] = '\\'; out[p++] = c; }
        else if (c == '\n') { out[p++] = '\\'; out[p++] = 'n'; }
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

int event_log_dump_since(uint64_t since_seq, char *buf, size_t buf_size,
                         uint64_t *last_seq)
{
    if (!s_mtx || !buf || buf_size < 4) return -1;

    size_t p = 0;
    buf[p++] = '{';
    p += snprintf(buf + p, buf_size - p, "\"events\":[");

    xSemaphoreTake(s_mtx, portMAX_DELAY);
    bool first = true;
    uint64_t local_last = since_seq;
    const size_t reserve = 40;
    size_t limit = (buf_size > reserve) ? (buf_size - reserve) : 0;

    for (int i = 0; i < EVT_RING; i++) {
        int idx = (s_head + i) % EVT_RING;
        const evt_t *e = &s_ring[idx];
        if (e->seq == 0 || e->seq <= since_seq) continue;

        size_t start = p;
        if (!first) {
            if (p + 1 >= limit) break;
            buf[p++] = ',';
        }
        int n = snprintf(buf + p, buf_size - p,
                         "{\"seq\":%llu,\"ms\":%lld,\"ts\":%lld,\"lvl\":%u,\"tag\":\"",
                         (unsigned long long)e->seq,
                         (long long)(e->ts_us / 1000),
                         e->epoch_ms,
                         (unsigned)e->level);
        if (n < 0 || p + (size_t)n >= limit) { p = start; break; }
        p += (size_t)n;
        p += append_json_str(buf + p, limit - p, e->tag);
        if (p + 10 >= limit) { p = start; break; }
        p += snprintf(buf + p, buf_size - p, "\",\"msg\":\"");
        p += append_json_str(buf + p, limit - p, e->msg);
        if (p + 3 >= limit) { p = start; break; }
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
