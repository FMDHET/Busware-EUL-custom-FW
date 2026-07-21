#include "tcp_server.h"
#include "board_config.h"
#include "sdkconfig.h"
#include "esp3_parser.h"
#include "enocean_uart.h"
#include "security.h"
#include "console_log.h"
#include "event_log.h"

#include <string.h>
#include <errno.h>
#include <stdio.h>

#include "lwip/sockets.h"
#include "lwip/netdb.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"

#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "eul-tcp";

typedef struct {
    bool                 active;
    bool                 authed;
    bool                 cleaned;    // idempotent-flag fuer close_slot
    volatile bool        tx_running; // von TX-Task gesetzt/geloescht
    int                  sock;
    char                 peer[24];
    StreamBufferHandle_t tx;
    esp3_parser_t        parser;
    int64_t              connected_at_us;
    uint64_t             rx_bytes;   // Bytes von diesem Client empfangen
    uint64_t             tx_bytes;   // Bytes an diesen Client gesendet
    uint32_t             rx_frames;  // vollstaendige ESP3-Frames von diesem Client
} client_slot_t;

static client_slot_t s_clients[CONFIG_EUL_MAX_CLIENTS];
static SemaphoreHandle_t s_slots_mtx;

static uint16_t    s_port;
static bool        s_auth_req;
static const char *s_token;

// -----------------------------------------------------------------------------
// Rate limit gegen AUTH-Bruteforce: pro IP zaehlen wir Fehl-Auths in einem
// Sliding-Window von 60 s. Ist der Zaehler >= EUL_AUTH_MAX_FAILS_PER_MIN wird
// jede weitere Connection dieser IP fuer 60 s abgewiesen.
// -----------------------------------------------------------------------------
#define RL_SLOTS 16
typedef struct {
    uint32_t ip_be;
    int64_t  window_start_us;
    int      fail_count;
    int64_t  blocked_until_us;
} rl_entry_t;

static rl_entry_t s_rl[RL_SLOTS];
static SemaphoreHandle_t s_rl_mtx;

static rl_entry_t *rl_find_or_alloc(uint32_t ip_be)
{
    rl_entry_t *free_slot = NULL;
    rl_entry_t *oldest    = &s_rl[0];
    for (int i = 0; i < RL_SLOTS; i++) {
        if (s_rl[i].ip_be == ip_be) return &s_rl[i];
        if (s_rl[i].ip_be == 0 && !free_slot) free_slot = &s_rl[i];
        if (s_rl[i].window_start_us < oldest->window_start_us) oldest = &s_rl[i];
    }
    if (!free_slot) free_slot = oldest;
    memset(free_slot, 0, sizeof(*free_slot));
    free_slot->ip_be = ip_be;
    free_slot->window_start_us = esp_timer_get_time();
    return free_slot;
}

static bool rl_is_blocked(uint32_t ip_be)
{
    bool blocked = false;
    xSemaphoreTake(s_rl_mtx, portMAX_DELAY);
    rl_entry_t *e = rl_find_or_alloc(ip_be);
    int64_t now = esp_timer_get_time();
    if (e->blocked_until_us > now) blocked = true;
    xSemaphoreGive(s_rl_mtx);
    return blocked;
}

static void rl_record_fail(uint32_t ip_be)
{
    xSemaphoreTake(s_rl_mtx, portMAX_DELAY);
    rl_entry_t *e = rl_find_or_alloc(ip_be);
    int64_t now = esp_timer_get_time();
    if (now - e->window_start_us > 60LL * 1000000LL) {
        e->window_start_us = now;
        e->fail_count = 0;
    }
    e->fail_count++;
    if (e->fail_count >= CONFIG_EUL_AUTH_MAX_FAILS_PER_MIN) {
        e->blocked_until_us = now + 60LL * 1000000LL;
        sec_event("auth_rate_limit",
                  "ip=%08lx blocked for 60s (fails=%d)",
                  (unsigned long)e->ip_be, e->fail_count);
    }
    xSemaphoreGive(s_rl_mtx);
}

static void rl_record_success(uint32_t ip_be)
{
    xSemaphoreTake(s_rl_mtx, portMAX_DELAY);
    rl_entry_t *e = rl_find_or_alloc(ip_be);
    e->fail_count = 0;
    e->blocked_until_us = 0;
    xSemaphoreGive(s_rl_mtx);
}

// -----------------------------------------------------------------------------
// Frame -> UART (unter Mutex des UART-Layers) + Konsole
// -----------------------------------------------------------------------------
static void on_esp3_frame(const uint8_t *frame, size_t len, void *user)
{
    client_slot_t *c = (client_slot_t *)user;
    if (c) {
        c->rx_frames++;
        console_log_frame_from(c->peer, frame, len);
    }
    (void)enocean_uart_write_frame(frame, len);
}

// Idempotent: kann von RX- und TX-Task aufgerufen werden - nur der erste
// Aufruf gibt Ressourcen frei, der zweite ist ein no-op.
static void close_slot_locked(client_slot_t *c)
{
    if (c->cleaned) return;
    c->cleaned = true;
    ESP_LOGI(TAG, "client %s disconnected", c->peer);
    console_logf("-- %s disconnected (rx=%llu tx=%llu frames=%u)",
                 c->peer,
                 (unsigned long long)c->rx_bytes,
                 (unsigned long long)c->tx_bytes,
                 (unsigned)c->rx_frames);
    EVT_INFO("tcp", "Client %s getrennt (rx=%llu tx=%llu frames=%u)",
             c->peer, (unsigned long long)c->rx_bytes,
             (unsigned long long)c->tx_bytes, (unsigned)c->rx_frames);
    if (c->sock >= 0) { shutdown(c->sock, SHUT_RDWR); close(c->sock); c->sock = -1; }
    if (c->tx)        { vStreamBufferDelete(c->tx);   c->tx = NULL; }
    c->active = false;
    c->authed = false;
    c->peer[0] = '\0';
}

static void close_slot(client_slot_t *c)
{
    xSemaphoreTake(s_slots_mtx, portMAX_DELAY);
    close_slot_locked(c);
    xSemaphoreGive(s_slots_mtx);
}

// Liest bis '\n', maximal buf_size-1 Bytes, oder Timeout. Rueckgabe Byte-Anzahl
// oder -1 bei Fehler / Timeout.
static int read_line(int sock, char *buf, size_t buf_size, int timeout_ms)
{
    struct timeval tv = { .tv_sec = timeout_ms / 1000, .tv_usec = (timeout_ms % 1000) * 1000 };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    size_t pos = 0;
    while (pos + 1 < buf_size) {
        char c;
        int n = recv(sock, &c, 1, 0);
        if (n <= 0) return -1;
        if (c == '\r') continue;
        if (c == '\n') { buf[pos] = '\0'; return (int)pos; }
        buf[pos++] = c;
    }
    return -1;
}

static bool do_auth_handshake(int sock, uint32_t ip_be)
{
    static const char BANNER[] = "HELLO EUL22 v1 AUTH-REQUIRED\n";
    if (send(sock, BANNER, sizeof(BANNER) - 1, 0) < 0) return false;

    char line[128];
    int n = read_line(sock, line, sizeof(line), CONFIG_EUL_AUTH_TCP_TIMEOUT_MS);
    if (n < 0) { sec_event("auth_timeout", "no AUTH within %d ms",
                           CONFIG_EUL_AUTH_TCP_TIMEOUT_MS); return false; }

    // Erwartetes Format: "AUTH <token>"
    if (strncmp(line, "AUTH ", 5) != 0) return false;
    const char *provided = line + 5;
    if (!sec_constant_time_equal(provided, s_token)) return false;

    static const char OK[] = "OK\n";
    if (send(sock, OK, sizeof(OK) - 1, 0) < 0) return false;

    // Timeout wieder abschalten
    struct timeval tv = { .tv_sec = 0, .tv_usec = 0 };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    rl_record_success(ip_be);
    return true;
}

static void client_rx_task(void *arg)
{
    client_slot_t *c = (client_slot_t *)arg;
    uint8_t buf[256];
    while (c->active) {
        int n = recv(c->sock, buf, sizeof(buf), 0);
        if (n <= 0) {
            if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            break;
        }
        c->rx_bytes += (uint64_t)n;
        esp3_parser_feed(&c->parser, buf, (size_t)n);
    }
    // RX-Task uebernimmt die Bereinigung des Sockets. Wir signalisieren dem
    // TX-Task zu beenden, brechen dessen ggf. blockierendes send() per
    // shutdown() auf und warten dann, dass er die Stream-Buffer-Referenz
    // freigibt - sonst wuerde vStreamBufferDelete unter ihm crashen.
    c->active = false;
    if (c->sock >= 0) shutdown(c->sock, SHUT_RDWR);
    for (int i = 0; i < 40 && c->tx_running; i++) {
        vTaskDelay(pdMS_TO_TICKS(25));
    }
    close_slot(c);
    vTaskDelete(NULL);
}

static void client_tx_task(void *arg)
{
    client_slot_t *c = (client_slot_t *)arg;
    uint8_t buf[256];
    c->tx_running = true;
    while (c->active) {
        size_t n = xStreamBufferReceive(c->tx, buf, sizeof(buf), pdMS_TO_TICKS(200));
        if (n == 0) continue;
        size_t off = 0;
        while (off < n && c->active) {
            int sent = send(c->sock, buf + off, n - off, 0);
            if (sent < 0) { c->active = false; break; }
            off += (size_t)sent;
            c->tx_bytes += (uint64_t)sent;
        }
    }
    // Kein close_slot mehr hier - RX-Task raeumt auf, sobald tx_running=false.
    c->tx_running = false;
    vTaskDelete(NULL);
}

static bool spawn_client(int sock, const struct sockaddr_in *addr)
{
    xSemaphoreTake(s_slots_mtx, portMAX_DELAY);
    client_slot_t *slot = NULL;
    for (int i = 0; i < CONFIG_EUL_MAX_CLIENTS; i++) {
        if (!s_clients[i].active) { slot = &s_clients[i]; break; }
    }
    if (!slot) { xSemaphoreGive(s_slots_mtx); return false; }

    memset(slot, 0, sizeof(*slot));
    slot->sock            = sock;
    slot->active          = true;
    slot->authed          = !s_auth_req;
    slot->connected_at_us = esp_timer_get_time();
    slot->tx              = xStreamBufferCreate(CONFIG_EUL_CLIENT_TX_STREAM_SIZE, 1);
    esp3_parser_init(&slot->parser, on_esp3_frame, slot);

    char ipbuf[16];
    inet_ntoa_r(addr->sin_addr, ipbuf, sizeof(ipbuf));
    snprintf(slot->peer, sizeof(slot->peer), "%s:%u", ipbuf, ntohs(addr->sin_port));

    if (!slot->tx) { close_slot_locked(slot); xSemaphoreGive(s_slots_mtx); return false; }

    xTaskCreate(client_rx_task, "eul-cli-rx", 4096, slot, 10, NULL);
    xTaskCreate(client_tx_task, "eul-cli-tx", 4096, slot, 10, NULL);
    xSemaphoreGive(s_slots_mtx);

    ESP_LOGI(TAG, "client %s connected%s", slot->peer,
             s_auth_req ? " (auth required)" : "");
    console_logf("++ %s connected%s", slot->peer,
                 s_auth_req ? " (auth ok)" : "");
    EVT_INFO("tcp", "Client %s verbunden", slot->peer);
    return true;
}

static void accept_task(void *arg)
{
    int lsock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (lsock < 0) { ESP_LOGE(TAG, "socket err=%d", errno); vTaskDelete(NULL); return; }

    int yes = 1;
    setsockopt(lsock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in bindaddr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = htonl(INADDR_ANY),
        .sin_port = htons(s_port),
    };
    if (bind(lsock, (struct sockaddr *)&bindaddr, sizeof(bindaddr)) < 0) {
        ESP_LOGE(TAG, "bind err=%d", errno); close(lsock); vTaskDelete(NULL); return;
    }
    if (listen(lsock, 2) < 0) {
        ESP_LOGE(TAG, "listen err=%d", errno); close(lsock); vTaskDelete(NULL); return;
    }
    ESP_LOGI(TAG, "listening on tcp/%d (auth=%s, max %d clients)",
             s_port, s_auth_req ? "required" : "off", CONFIG_EUL_MAX_CLIENTS);

    while (1) {
        struct sockaddr_in peer;
        socklen_t sl = sizeof(peer);
        int csock = accept(lsock, (struct sockaddr *)&peer, &sl);
        if (csock < 0) { vTaskDelay(pdMS_TO_TICKS(500)); continue; }

        uint32_t ip_be = peer.sin_addr.s_addr;

        // Rate-Limit-Vorpruefung
        if (s_auth_req && rl_is_blocked(ip_be)) {
            sec_event("auth_blocked", "connect from blocked ip %08lx dropped",
                      (unsigned long)ip_be);
            close(csock);
            continue;
        }

        // TCP-Keepalive
        int ka = 1, idle = 30, intvl = 10, cnt = 3;
        setsockopt(csock, SOL_SOCKET,  SO_KEEPALIVE, &ka,    sizeof(ka));
        setsockopt(csock, IPPROTO_TCP, TCP_KEEPIDLE, &idle,  sizeof(idle));
        setsockopt(csock, IPPROTO_TCP, TCP_KEEPINTVL,&intvl, sizeof(intvl));
        setsockopt(csock, IPPROTO_TCP, TCP_KEEPCNT,  &cnt,   sizeof(cnt));

        // AUTH-Handshake VOR dem Spawn - im accept-Task ist es simpler und
        // haelt fehlgeschlagene AUTH-Attempts aus der Client-Slot-Ressource raus.
        if (s_auth_req) {
            if (!do_auth_handshake(csock, ip_be)) {
                sec_event("auth_fail", "peer=%d.%d.%d.%d",
                          (int)(ip_be & 0xff),
                          (int)((ip_be >> 8) & 0xff),
                          (int)((ip_be >> 16) & 0xff),
                          (int)((ip_be >> 24) & 0xff));
                rl_record_fail(ip_be);
                // Kleine Verzoegerung erschwert Bruteforce zusaetzlich
                vTaskDelay(pdMS_TO_TICKS(500));
                close(csock);
                continue;
            }
        }

        if (!spawn_client(csock, &peer)) {
            ESP_LOGW(TAG, "no free client slot, dropping");
            close(csock);
        }
    }
}

esp_err_t tcp_server_start(uint16_t port, bool auth_required, const char *token)
{
    if (auth_required && (!token || !token[0])) return ESP_ERR_INVALID_ARG;
    s_port     = port ? port : CONFIG_EUL_DEFAULT_TCP_PORT;
    s_auth_req = auth_required;
    s_token    = token;

    s_slots_mtx = xSemaphoreCreateMutex();
    s_rl_mtx    = xSemaphoreCreateMutex();
    if (!s_slots_mtx || !s_rl_mtx) return ESP_ERR_NO_MEM;

    memset(s_clients, 0, sizeof(s_clients));
    memset(s_rl,      0, sizeof(s_rl));
    for (int i = 0; i < CONFIG_EUL_MAX_CLIENTS; i++) s_clients[i].sock = -1;

    xTaskCreate(accept_task, "eul-tcp-acc", 5120, NULL, 9, NULL);
    return ESP_OK;
}

void tcp_server_broadcast(const uint8_t *data, size_t len)
{
    if (!data || len == 0) return;
    xSemaphoreTake(s_slots_mtx, portMAX_DELAY);
    for (int i = 0; i < CONFIG_EUL_MAX_CLIENTS; i++) {
        client_slot_t *c = &s_clients[i];
        if (!c->active || !c->tx) continue;
        (void)xStreamBufferSend(c->tx, data, len, 0);
    }
    xSemaphoreGive(s_slots_mtx);
}

int tcp_server_active_clients(void)
{
    int n = 0;
    xSemaphoreTake(s_slots_mtx, portMAX_DELAY);
    for (int i = 0; i < CONFIG_EUL_MAX_CLIENTS; i++) {
        if (s_clients[i].active) n++;
    }
    xSemaphoreGive(s_slots_mtx);
    return n;
}

int tcp_server_dump_clients_json(char *out, size_t out_size)
{
    if (!out || out_size < 4) return -1;
    size_t p = 0;
    out[p++] = '[';

    int64_t now = esp_timer_get_time();
    xSemaphoreTake(s_slots_mtx, portMAX_DELAY);
    bool first = true;
    for (int i = 0; i < CONFIG_EUL_MAX_CLIENTS; i++) {
        const client_slot_t *c = &s_clients[i];
        if (!c->active) continue;
        if (!first) {
            if (p + 1 >= out_size) break;
            out[p++] = ',';
        }
        first = false;
        int n = snprintf(out + p, out_size - p,
            "{\"peer\":\"%s\",\"connected_ms\":%lld,\"rx_bytes\":%llu,\"tx_bytes\":%llu,\"rx_frames\":%u}",
            c->peer,
            (long long)((now - c->connected_at_us) / 1000),
            (unsigned long long)c->rx_bytes,
            (unsigned long long)c->tx_bytes,
            (unsigned)c->rx_frames);
        if (n < 0 || (size_t)n >= out_size - p) break;
        p += (size_t)n;
    }
    xSemaphoreGive(s_slots_mtx);

    if (p + 2 >= out_size) return -1;
    out[p++] = ']';
    out[p] = '\0';
    return (int)p;
}
