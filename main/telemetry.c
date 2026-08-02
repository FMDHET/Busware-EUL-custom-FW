#include "telemetry.h"
#include "esp3_parser.h"

#include <string.h>
#include <stdio.h>
#include <sys/time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_timer.h"

#define TEL_RING        EUL_TEL_RING
#define TEL_FRAME_MAX   EUL_TEL_FRAME_MAX

// Groesster JSON-Eintrag: raw-Hex (2 Zeichen je Byte) + data-Hex + Klartext
// + Rahmen. Bei TEL_FRAME_MAX=96 sind das ~580 Byte, 768 laesst Luft.
#define TEL_JSON_MAX    768

#define DIR_RX  0
#define DIR_TX  1

typedef struct {
    uint64_t  seq;   // 0 = leer; monoton, dient dem Portal als Cursor
    uint8_t   buf[TEL_FRAME_MAX];
    uint8_t   len;
    uint8_t   dir;   // DIR_RX / DIR_TX
    int64_t   ms;    // Uptime ms bei Empfang
    long long ts;    // Echtzeit epoch ms bei Empfang (0 = nicht synchron)
} tel_entry_t;

static tel_entry_t          s_ring[TEL_RING];
static int                  s_head;
static uint64_t             s_next_seq = 1;
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

// Formatiert einen Ring-Eintrag als JSON-Objekt. 0 wenn der Frame unbrauchbar
// ist oder der Puffer nicht reicht.
//
// Nicht-RADIO-Pakete (RESPONSE, COMMON_COMMAND, ...) kommen ebenfalls in den
// Ring - die Statusseite zeigt sie in der Spalte "Typ" und sie sind beim
// Debuggen der TCM-Kommunikation genau das Interessante. Fuer sie bleiben
// rorg/sender leere Strings (kein null, damit Fremd-Consumer der REST-API
// weiter mit String-Feldern rechnen koennen) und "data" ist der Nutzteil.
static int format_entry(char *out, size_t cap, const tel_entry_t *e)
{
    const uint8_t *frame = e->buf;
    size_t         len   = e->len;
    if (len < 7 || frame[0] != 0x55) return 0;

    size_t data_len = ((size_t)frame[1] << 8) | frame[2];
    size_t opt_len  = frame[3];
    uint8_t type    = frame[4];
    if (6 + data_len > len) return 0;

    const uint8_t *data  = frame + 6;
    int            radio = (type == 0x01 && data_len >= 6);

    size_t p = 0;
    int n = snprintf(out + p, cap - p,
                     "{\"seq\":%llu,\"dir\":\"%s\",\"ts\":%lld,\"ms\":%lld,"
                     "\"typ\":%u,\"rorg\":\"",
                     (unsigned long long)e->seq,
                     e->dir == DIR_TX ? "tx" : "rx",
                     e->ts, (long long)e->ms, (unsigned)type);
    if (n < 0 || (size_t)n >= cap - p) return 0;
    p += (size_t)n;

    const uint8_t *payload = data;
    size_t         pay_len = data_len;
    uint8_t        status  = 0;

    if (radio) {
        payload = data + 1;
        pay_len = data_len - 6;
        status  = data[data_len - 1];
        p = put_hex(out, cap, p, data, 1, 0);          // RORG
        n = snprintf(out + p, cap - p, "\",\"sender\":\"");
        if (n < 0 || (size_t)n >= cap - p) return 0;
        p += (size_t)n;
        p = put_hex(out, cap, p, data + data_len - 5, 4, '-');
    } else {
        n = snprintf(out + p, cap - p, "\",\"sender\":\"");
        if (n < 0 || (size_t)n >= cap - p) return 0;
        p += (size_t)n;
    }

    n = snprintf(out + p, cap - p, "\",\"data\":\"");
    if (n < 0 || (size_t)n >= cap - p) return 0;
    p += (size_t)n;
    p = put_hex(out, cap, p, payload, pay_len, 0);

    n = snprintf(out + p, cap - p, "\",\"raw\":\"");
    if (n < 0 || (size_t)n >= cap - p) return 0;
    p += (size_t)n;
    p = put_hex(out, cap, p, frame, len, 0);

    // 0xFF im dBm-Byte heisst laut ESP3-Spec "nicht verfuegbar" - so sind
    // gesendete Frames markiert. Ohne diese Pruefung meldet das Portal fuer
    // jedes gesendete Telegramm -255 dBm.
    const uint8_t *opt = frame + 6 + data_len;
    int has_dbm = (radio && opt_len >= 6 && 6 + data_len + opt_len <= len && opt[5] != 0xFF);

    char text[80];
    text[0] = '\0';
    if (radio) describe(text, sizeof(text), data[0], payload, pay_len, status);

    if (has_dbm) n = snprintf(out + p, cap - p, "\",\"text\":\"%s\",\"dbm\":%d}", text, -(int)opt[5]);
    else         n = snprintf(out + p, cap - p, "\",\"text\":\"%s\",\"dbm\":null}", text);
    if (n < 0 || (size_t)n >= cap - p) return 0;
    p += (size_t)n;
    return (int)p;
}

// Frame in den Ring legen. Laeuft aus dem UART-RX-Task (rx) sowie aus den
// TCP-/USB-/REST-Sendepfaden (tx) - deshalb komplett unter Mutex.
static void ring_put(const uint8_t *frame, size_t len, uint8_t dir)
{
    // Zu grosse Frames gar nicht erst aufnehmen: eine halbe Kopie liesse sich
    // nicht dekodieren und wuerde nur einen Ringplatz verbrennen (siehe
    // EUL_TEL_FRAME_MAX).
    if (len < 6 || len > TEL_FRAME_MAX) return;
    if (!s_mtx) return;   // telemetry_init() nie gelaufen / Mutex-Anlage schlug fehl

    int64_t ms = esp_timer_get_time() / 1000;
    struct timeval tv;
    gettimeofday(&tv, NULL);
    long long ts = (tv.tv_sec > 1700000000LL)
        ? ((long long)tv.tv_sec * 1000 + tv.tv_usec / 1000) : 0;

    xSemaphoreTake(s_mtx, portMAX_DELAY);
    tel_entry_t *e = &s_ring[s_head];
    memcpy(e->buf, frame, len);
    e->len = (uint8_t)len;
    e->dir = dir;
    e->ms  = ms;
    e->ts  = ts;
    e->seq = s_next_seq++;
    s_head = (s_head + 1) % TEL_RING;
    xSemaphoreGive(s_mtx);
}

static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    (void)user;
    ring_put(frame, len, DIR_RX);

    if (!s_mtx) return;
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    telemetry_frame_cb_t cb = s_cb;
    void *cbu = s_cb_user;
    xSemaphoreGive(s_mtx);
    // Callback bleibt wie dokumentiert auf RADIO_ERP1 beschraenkt.
    if (cb && len >= 7 && frame[4] == 0x01) cb(frame, len, cbu);
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

void telemetry_note_tx(const uint8_t *frame, size_t len)
{
    ring_put(frame, len, DIR_TX);
}

void telemetry_set_frame_cb(telemetry_frame_cb_t cb, void *user)
{
    if (!s_mtx) return;
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    s_cb = cb;
    s_cb_user = user;
    xSemaphoreGive(s_mtx);
}

int telemetry_dump_json_stream(uint64_t since_seq, telemetry_emit_t emit, void *user)
{
    if (!s_mtx || !emit) return -1;
    if (emit(user, "[", 1) < 0) return -1;

    // Startposition einmal schnappen. Kommen waehrend des Dumps neue Frames
    // dazu, gehen sie hoechstens beim naechsten Poll mit - der Cursor (seq)
    // stellt sicher, dass nichts doppelt oder verloren geliefert wird.
    xSemaphoreTake(s_mtx, portMAX_DELAY);
    int head = s_head;
    xSemaphoreGive(s_mtx);

    char obj[TEL_JSON_MAX];
    bool first = true;
    for (int i = 0; i < TEL_RING; i++) {
        // Eintrag einzeln kopieren statt den Lock ueber den ganzen Dump zu
        // halten: emit() schreibt auf den Socket und kann blockieren, solange
        // darf der UART-RX-Task nicht warten muessen.
        tel_entry_t e;
        xSemaphoreTake(s_mtx, portMAX_DELAY);
        e = s_ring[(head + i) % TEL_RING];
        xSemaphoreGive(s_mtx);

        if (e.len == 0 || e.seq <= since_seq) continue;
        int n = format_entry(obj, sizeof(obj), &e);
        if (n <= 0) continue;
        if (!first && emit(user, ",", 1) < 0) return -1;
        if (emit(user, obj, (size_t)n) < 0) return -1;
        first = false;
    }

    if (emit(user, "]", 1) < 0) return -1;
    return 0;
}

int telemetry_frame_to_json(const uint8_t *frame, size_t len, char *out, size_t out_size)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);

    if (len > TEL_FRAME_MAX) return 0;
    tel_entry_t e = {0};
    e.len = (uint8_t)len;
    memcpy(e.buf, frame, e.len);
    e.dir = DIR_RX;
    e.ms  = esp_timer_get_time() / 1000;
    e.ts  = (tv.tv_sec > 1700000000LL)
        ? ((long long)tv.tv_sec * 1000 + tv.tv_usec / 1000) : 0;
    return format_entry(out, out_size, &e);
}
