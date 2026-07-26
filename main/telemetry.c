#include "telemetry.h"
#include "esp3_parser.h"

#include <string.h>
#include <stdio.h>
#include <sys/time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_timer.h"

#define TEL_RING        32
#define TEL_FRAME_MAX   64

typedef struct {
    uint8_t   buf[TEL_FRAME_MAX];
    uint8_t   len;
    int64_t   ms;    // Uptime ms bei Empfang
    long long ts;    // Echtzeit epoch ms bei Empfang (0 = nicht synchron)
} tel_entry_t;

static tel_entry_t          s_ring[TEL_RING];
static int                  s_head;
static SemaphoreHandle_t    s_mtx;
static esp3_parser_t        s_parser;
static telemetry_frame_cb_t s_cb;
static void                *s_cb_user;

static size_t put_hex(char *o, size_t cap, size_t p,
                      const uint8_t *b, size_t n, char sep)
{
    static const char H[] = "0123456789ABCDEF";
    for (size_t i = 0; i < n; i++) {
        if (sep && i) { if (p + 1 >= cap) break; o[p++] = sep; }
        if (p + 2 >= cap) break;
        o[p++] = H[b[i] >> 4];
        o[p++] = H[b[i] & 0x0f];
    }
    return p;
}

// Diese Texte gehen als "text"-Feld ueber /api/telegrams nach draussen und
// verwenden daher echte Umlaute (UTF-8, wie das JSON selbst).
static const char *RPS_BTN[8] = {
    "Wippe A unten", "Wippe A oben", "Wippe B unten", "Wippe B oben",
    "Taste 5", "Taste 6", "Taste 7", "Taste 8"
};

// Klartext-Deutung (spiegelt die Frontend-Logik): RPS-Schalter, 1BS-Kontakt,
// 4BS-Zentralkommando (A5-38-08). Leerer String wenn nicht deutbar.
static void describe(char *out, size_t cap, uint8_t rorg,
                     const uint8_t *pay, size_t pay_len, uint8_t status)
{
    out[0] = '\0';
    if (rorg == 0xF6 && pay_len >= 1) {
        uint8_t db0 = pay[0];
        int eb = (db0 & 0x10) != 0;
        // Status-Bit 5 (0x20) ist T21 - bei PTM-Wippen immer gesetzt. Ist es
        // NICHT gesetzt, stammt das Telegramm nicht von einem Standard-Taster
        // und die Wippen-Zuordnung waere geraten; dann nur grob deuten.
        if ((status & 0x20) == 0) {
            snprintf(out, cap, "%s", eb ? "Taste(n) gedrückt" : "losgelassen");
        } else if (!eb && db0 == 0x00) {
            snprintf(out, cap, "losgelassen");
        } else if (db0 & 0x01) {
            snprintf(out, cap, "%s %s + %s", RPS_BTN[(db0 >> 5) & 7],
                     eb ? "gedrückt" : "losgelassen", RPS_BTN[(db0 >> 1) & 7]);
        } else {
            snprintf(out, cap, "%s %s", RPS_BTN[(db0 >> 5) & 7],
                     eb ? "gedrückt" : "losgelassen");
        }
    } else if (rorg == 0xD5 && pay_len >= 1) {
        snprintf(out, cap, (pay[0] & 0x01) ? "Kontakt geschlossen" : "Kontakt offen");
    } else if (rorg == 0xA5 && pay_len == 4) {
        uint8_t db3 = pay[0], db2 = pay[1], db0 = pay[3];
        if ((db0 & 0x08) == 0)      snprintf(out, cap, "Lerntelegramm");
        else if (db3 == 0x01)       snprintf(out, cap, (db0 & 0x01) ? "Einschalten" : "Ausschalten");
        else if (db3 == 0x02)       snprintf(out, cap, "Dimmen auf %u%%%s", (unsigned)db2, (db0 & 0x01) ? "" : " (aus)");
    }
}

// Formatiert einen ESP3-RADIO_ERP1-Frame als JSON-Objekt. 0 wenn kein
// RADIO_ERP1 oder Puffer zu klein.
static int format_frame(char *out, size_t cap, const uint8_t *frame, size_t len,
                        int64_t ms, long long ts)
{
    if (len < 7 || frame[0] != 0x55) return 0;
    size_t data_len = ((size_t)frame[1] << 8) | frame[2];
    size_t opt_len  = frame[3];
    uint8_t type    = frame[4];
    if (type != 0x01 || data_len < 6 || 6 + data_len > len) return 0;

    const uint8_t *data    = frame + 6;
    uint8_t        rorg    = data[0];
    const uint8_t *sender  = data + data_len - 5;
    uint8_t        status  = data[data_len - 1];
    const uint8_t *payload = data + 1;
    size_t         pay_len = data_len - 6;
    const uint8_t *opt     = frame + 6 + data_len;
    int has_dbm = (opt_len >= 6 && 6 + data_len + opt_len <= len);
    int dbm     = has_dbm ? -(int)opt[5] : 0;

    size_t p = 0;
    int n = snprintf(out + p, cap - p,
                     "{\"ts\":%lld,\"ms\":%lld,\"rorg\":\"%02X\",\"sender\":\"",
                     ts, (long long)ms, rorg);
    if (n < 0 || (size_t)n >= cap - p) return 0;
    p += (size_t)n;
    p = put_hex(out, cap, p, sender, 4, '-');

    n = snprintf(out + p, cap - p, "\",\"data\":\"");
    if (n < 0 || (size_t)n >= cap - p) return 0;
    p += (size_t)n;
    p = put_hex(out, cap, p, payload, pay_len, 0);

    n = snprintf(out + p, cap - p, "\",\"raw\":\"");
    if (n < 0 || (size_t)n >= cap - p) return 0;
    p += (size_t)n;
    p = put_hex(out, cap, p, frame, len, 0);

    char text[80];
    describe(text, sizeof(text), rorg, payload, pay_len, status);
    if (has_dbm) n = snprintf(out + p, cap - p, "\",\"text\":\"%s\",\"dbm\":%d}", text, dbm);
    else         n = snprintf(out + p, cap - p, "\",\"text\":\"%s\",\"dbm\":null}", text);
    if (n < 0 || (size_t)n >= cap - p) return 0;
    p += (size_t)n;
    return (int)p;
}

static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    (void)user;
    // nur RADIO_ERP1 (Packet-Type 0x01) in die Telemetrie
    if (len < 7 || frame[4] != 0x01) return;
    if (!s_mtx) return;   // telemetry_init() nie gelaufen / Mutex-Anlage schlug fehl

    int64_t ms = esp_timer_get_time() / 1000;
    struct timeval tv;
    gettimeofday(&tv, NULL);
    long long ts = (tv.tv_sec > 1700000000LL)
        ? ((long long)tv.tv_sec * 1000 + tv.tv_usec / 1000) : 0;

    size_t stored = len > TEL_FRAME_MAX ? TEL_FRAME_MAX : len;

    xSemaphoreTake(s_mtx, portMAX_DELAY);
    tel_entry_t *e = &s_ring[s_head];
    memcpy(e->buf, frame, stored);
    e->len = (uint8_t)stored;
    e->ms  = ms;
    e->ts  = ts;
    s_head = (s_head + 1) % TEL_RING;
    telemetry_frame_cb_t cb = s_cb;
    void *cbu = s_cb_user;
    xSemaphoreGive(s_mtx);

    if (cb) cb(frame, len, cbu);   // ausserhalb des Locks aufrufen
}

void telemetry_init(void)
{
    if (s_mtx) return;
    s_mtx = xSemaphoreCreateMutex();
    memset(s_ring, 0, sizeof(s_ring));
    esp3_parser_init(&s_parser, on_frame, NULL);
}

void telemetry_feed_rx(const uint8_t *data, size_t len)
{
    // Wird nur aus dem einen UART-RX-Task gefuettert -> Parser braucht kein Lock.
    esp3_parser_feed(&s_parser, data, len);
}

void telemetry_set_frame_cb(telemetry_frame_cb_t cb, void *user)
{
    if (!s_mtx) return;
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    s_cb = cb;
    s_cb_user = user;
    xSemaphoreGive(s_mtx);
}

int telemetry_dump_json(char *out, size_t out_size)
{
    if (!s_mtx || out_size < 4) return -1;

    size_t p = 0;
    out[p++] = '[';

    xSemaphoreTake(s_mtx, portMAX_DELAY);
    bool first = true;
    for (int i = 0; i < TEL_RING; i++) {
        int idx = (s_head + i) % TEL_RING;
        tel_entry_t *e = &s_ring[idx];
        if (e->len == 0) continue;

        size_t need_comma = first ? 0 : 1;
        if (p + need_comma + 2 >= out_size) break;    // Platz fuer Komma + "]\0"
        size_t at = p + need_comma;
        int n = format_frame(out + at, out_size - 2 - at, e->buf, e->len, e->ms, e->ts);
        if (n <= 0) continue;                          // nicht formatierbar -> Komma nicht setzen
        if (need_comma) out[p] = ',';
        p = at + (size_t)n;
        first = false;
    }
    xSemaphoreGive(s_mtx);

    if (p + 2 > out_size) return -1;
    out[p++] = ']';
    out[p]   = '\0';
    return (int)p;
}

int telemetry_frame_to_json(const uint8_t *frame, size_t len, char *out, size_t out_size)
{
    int64_t ms = esp_timer_get_time() / 1000;
    struct timeval tv;
    gettimeofday(&tv, NULL);
    long long ts = (tv.tv_sec > 1700000000LL)
        ? ((long long)tv.tv_sec * 1000 + tv.tv_usec / 1000) : 0;
    return format_frame(out, out_size, frame, len, ms, ts);
}
