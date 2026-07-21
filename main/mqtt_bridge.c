#include "mqtt_bridge.h"
#include "telemetry.h"
#include "enocean_uart.h"
#include "tcp_server.h"
#include "wifi_sta.h"
#include "event_log.h"

#include <string.h>
#include <stdio.h>

#include "mqtt_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "eul-mqtt";

#define SEEN_MAX 48

static esp_mqtt_client_handle_t s_client;
static volatile bool s_connected;      // nur wenn true wird publiziert
static char s_base[64];
static char s_topic_rx[96];
static char s_topic_send[96];
static char s_topic_avail[96];
static char s_topic_gw[96];
static char s_suffix[8];
static char s_prefix[40];
static char s_devname[48];
static char s_dev_json[176];
static bool s_discovery;
static bool s_retain;

static char s_seen[SEEN_MAX][9];
static int  s_seen_n;
static SemaphoreHandle_t s_seen_mtx;

// ----- Hilfen ---------------------------------------------------------------
static size_t parse_hex(const char *s, size_t slen, uint8_t *out, size_t outcap)
{
    size_t n = 0;
    int hi = -1;
    for (size_t i = 0; i < slen && n < outcap; i++) {
        char c = s[i];
        int v;
        if      (c >= '0' && c <= '9') v = c - '0';
        else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
        else continue;
        if (hi < 0) hi = v;
        else { out[n++] = (uint8_t)((hi << 4) | v); hi = -1; }
    }
    return n;
}

// Sender-ID (4 Byte) eines RADIO_ERP1-Frames als "AABBCCDD".
static bool frame_sender(const uint8_t *frame, size_t len, char *out9)
{
    if (len < 7 || frame[0] != 0x55) return false;
    size_t dl = ((size_t)frame[1] << 8) | frame[2];
    if (frame[4] != 0x01 || dl < 6 || 6 + dl > len) return false;
    const uint8_t *s = frame + 6 + dl - 5;
    snprintf(out9, 9, "%02X%02X%02X%02X", s[0], s[1], s[2], s[3]);
    return true;
}

// true wenn sid neu war (dann Discovery ausloesen).
static bool mark_seen(const char *sid)
{
    bool is_new = false;
    xSemaphoreTake(s_seen_mtx, portMAX_DELAY);
    int i;
    for (i = 0; i < s_seen_n; i++) if (strcmp(s_seen[i], sid) == 0) break;
    if (i == s_seen_n && s_seen_n < SEEN_MAX) {
        snprintf(s_seen[s_seen_n], 9, "%s", sid);
        s_seen_n++;
        is_new = true;
    }
    xSemaphoreGive(s_seen_mtx);
    return is_new;
}

// ----- HA Discovery ---------------------------------------------------------
static void pub_gw_sensor(const char *key, const char *payload)
{
    char topic[128];
    snprintf(topic, sizeof(topic), "%s/sensor/eul22_%s/%s/config", s_prefix, s_suffix, key);
    esp_mqtt_client_enqueue(s_client, topic, payload, strlen(payload), 0, 1, true);
}

static void publish_gw_discovery(void)
{
    char pl[768];
    snprintf(pl, sizeof(pl),
        "{\"name\":\"WLAN-Signal\",\"uniq_id\":\"eul22_%s_rssi\",\"stat_t\":\"%s\","
        "\"val_tpl\":\"{{value_json.rssi}}\",\"dev_cla\":\"signal_strength\",\"unit_of_meas\":\"dBm\","
        "\"stat_cla\":\"measurement\",\"ent_cat\":\"diagnostic\",\"avty_t\":\"%s\",\"dev\":%s}",
        s_suffix, s_topic_gw, s_topic_avail, s_dev_json);
    pub_gw_sensor("rssi", pl);

    snprintf(pl, sizeof(pl),
        "{\"name\":\"Uptime\",\"uniq_id\":\"eul22_%s_uptime\",\"stat_t\":\"%s\","
        "\"val_tpl\":\"{{value_json.uptime_s}}\",\"dev_cla\":\"duration\",\"unit_of_meas\":\"s\","
        "\"ent_cat\":\"diagnostic\",\"avty_t\":\"%s\",\"dev\":%s}",
        s_suffix, s_topic_gw, s_topic_avail, s_dev_json);
    pub_gw_sensor("uptime", pl);

    snprintf(pl, sizeof(pl),
        "{\"name\":\"TCP-Clients\",\"uniq_id\":\"eul22_%s_clients\",\"stat_t\":\"%s\","
        "\"val_tpl\":\"{{value_json.clients}}\",\"stat_cla\":\"measurement\","
        "\"ent_cat\":\"diagnostic\",\"avty_t\":\"%s\",\"dev\":%s}",
        s_suffix, s_topic_gw, s_topic_avail, s_dev_json);
    pub_gw_sensor("clients", pl);

    snprintf(pl, sizeof(pl),
        "{\"name\":\"Letztes Telegramm\",\"uniq_id\":\"eul22_%s_last\",\"stat_t\":\"%s\","
        "\"val_tpl\":\"{{value_json.text}}\",\"json_attr_t\":\"%s\",\"avty_t\":\"%s\",\"dev\":%s}",
        s_suffix, s_topic_rx, s_topic_rx, s_topic_avail, s_dev_json);
    pub_gw_sensor("last", pl);
}

static void publish_sender_discovery(const char *sid)
{
    char topic[128];
    snprintf(topic, sizeof(topic),
             "%s/sensor/eul22_%s_%s/telegram/config", s_prefix, s_suffix, sid);
    char pl[768];
    int n = snprintf(pl, sizeof(pl),
        "{\"name\":\"Telegramm\",\"uniq_id\":\"eul22_%s_%s\",\"stat_t\":\"%s/dev/%s\","
        "\"val_tpl\":\"{{value_json.text}}\",\"json_attr_t\":\"%s/dev/%s\",\"avty_t\":\"%s\","
        "\"dev\":{\"ids\":[\"eul22_%s_%s\"],\"name\":\"EnOcean %s\",\"via_device\":\"eul22_%s\"}}",
        s_suffix, sid, s_base, sid, s_base, sid, s_topic_avail,
        s_suffix, sid, sid, s_suffix);
    if (n > 0 && n < (int)sizeof(pl)) {
        esp_mqtt_client_enqueue(s_client, topic, pl, n, 0, 1, true);
        ESP_LOGI(TAG, "HA-Discovery fuer Sender %s", sid);
    }
}

// ----- Publizieren ----------------------------------------------------------
static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    (void)user;
    // Nur bei bestehender Broker-Verbindung publizieren. So macht der UART-RX-
    // Task bei getrenntem MQTT (Broker/Mesh weg) NULL MQTT-Arbeit und kann
    // dadurch nie blockieren.
    if (!s_client || !s_connected) return;

    char json[256];
    int n = telemetry_frame_to_json(frame, len, json, sizeof(json));
    if (n <= 0) return;

    // WICHTIG: enqueue statt publish - publish blockiert den UART-RX-Task bis
    // zu network_timeout (~10s), wenn der Broker nicht erreichbar ist (Mesh-
    // Aussetzer) und laesst damit das ganze Gateway haengen. store=false ->
    // bei Trennung verwerfen statt Outbox/Heap zu fluten.
    esp_mqtt_client_enqueue(s_client, s_topic_rx, json, n, 0, 0, false);   // Stream

    char sid[9];
    if (!frame_sender(frame, len, sid)) return;

    char dev_topic[96];
    snprintf(dev_topic, sizeof(dev_topic), "%s/dev/%s", s_base, sid);
    esp_mqtt_client_enqueue(s_client, dev_topic, json, n, 0, s_retain ? 1 : 0, false);

    if (s_discovery && mark_seen(sid)) publish_sender_discovery(sid);
}

static void gw_stats_publish(void *arg)
{
    (void)arg;
    if (!s_client || !s_connected) return;
    int rssi = 0;
    esp_wifi_sta_get_rssi(&rssi);
    const char *ip = wifi_sta_ip_str();
    char pl[160];
    int n = snprintf(pl, sizeof(pl),
        "{\"rssi\":%d,\"uptime_s\":%lld,\"clients\":%d,\"ip\":\"%s\"}",
        rssi, (long long)(esp_timer_get_time() / 1000000),
        tcp_server_active_clients(), ip ? ip : "");
    esp_mqtt_client_enqueue(s_client, s_topic_gw, pl, n, 0, s_retain ? 1 : 0, false);
}

static void mqtt_event_handler(void *args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    (void)args; (void)base;
    esp_mqtt_event_handle_t e = (esp_mqtt_event_handle_t)event_data;

    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED:
        s_connected = true;
        esp_mqtt_client_enqueue(s_client, s_topic_avail, "online", 6, 0, 1, true);
        esp_mqtt_client_subscribe(s_client, s_topic_send, 0);
        // Sender nach (Re)connect neu ankuendigen (Discovery ist retained).
        xSemaphoreTake(s_seen_mtx, portMAX_DELAY);
        s_seen_n = 0;
        xSemaphoreGive(s_seen_mtx);
        if (s_discovery) publish_gw_discovery();
        gw_stats_publish(NULL);
        EVT_INFO("mqtt", "verbunden (discovery=%d, retain=%d)", s_discovery, s_retain);
        break;

    case MQTT_EVENT_DISCONNECTED:
        s_connected = false;
        EVT_WARN("mqtt", "getrennt");
        break;

    case MQTT_EVENT_DATA:
        if (e->topic && e->topic_len == (int)strlen(s_topic_send) &&
            strncmp(e->topic, s_topic_send, e->topic_len) == 0) {
            uint8_t frame[64];
            size_t nf = parse_hex(e->data, e->data_len, frame, sizeof(frame));
            if (nf >= 6) {
                enocean_uart_write_frame(frame, nf);
                ESP_LOGI(TAG, "cmd %u bytes -> TCM515", (unsigned)nf);
            }
        }
        break;

    default:
        break;
    }
}

void mqtt_bridge_start(const mqtt_bridge_cfg_t *c)
{
    if (!c || !c->host || !c->host[0]) {
        ESP_LOGW(TAG, "kein Broker-Host - MQTT nicht gestartet");
        return;
    }
    const char *base = (c->base_topic && c->base_topic[0]) ? c->base_topic : "eul22";
    snprintf(s_base,        sizeof(s_base),        "%s", base);
    snprintf(s_topic_rx,    sizeof(s_topic_rx),    "%s/rx", base);
    snprintf(s_topic_send,  sizeof(s_topic_send),  "%s/send", base);
    snprintf(s_topic_avail, sizeof(s_topic_avail), "%s/status", base);
    snprintf(s_topic_gw,    sizeof(s_topic_gw),    "%s/gateway", base);
    snprintf(s_suffix, sizeof(s_suffix), "%s", (c->suffix && c->suffix[0]) ? c->suffix : "0");
    snprintf(s_prefix, sizeof(s_prefix), "%s", (c->disc_prefix && c->disc_prefix[0]) ? c->disc_prefix : "homeassistant");
    if (c->device_name && c->device_name[0]) snprintf(s_devname, sizeof(s_devname), "%s", c->device_name);
    else snprintf(s_devname, sizeof(s_devname), "EUL22 %s", s_suffix);
    snprintf(s_dev_json, sizeof(s_dev_json),
             "{\"ids\":[\"eul22_%s\"],\"name\":\"%s\",\"mf\":\"FMDHET\",\"mdl\":\"Busware EUL22\"}",
             s_suffix, s_devname);
    s_discovery = c->discovery;
    s_retain    = c->retain;

    if (!s_seen_mtx) s_seen_mtx = xSemaphoreCreateMutex();
    s_seen_n = 0;

    char uri[96];
    snprintf(uri, sizeof(uri), "mqtt://%s:%u", c->host, c->port ? c->port : 1883);

    esp_mqtt_client_config_t cfg = {
        .broker.address.uri = uri,
        .session.last_will.topic   = s_topic_avail,
        .session.last_will.msg     = "offline",
        .session.last_will.msg_len = 7,
        .session.last_will.qos     = 0,
        .session.last_will.retain  = 1,
    };
    if (c->user && c->user[0]) cfg.credentials.username = c->user;
    if (c->pass && c->pass[0]) cfg.credentials.authentication.password = c->pass;

    s_client = esp_mqtt_client_init(&cfg);
    if (!s_client) { ESP_LOGE(TAG, "mqtt init fehlgeschlagen"); return; }

    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    esp_mqtt_client_start(s_client);
    telemetry_set_frame_cb(on_frame, NULL);

    const esp_timer_create_args_t ta = { .callback = gw_stats_publish, .name = "eul-mqtt-stats" };
    esp_timer_handle_t th;
    if (esp_timer_create(&ta, &th) == ESP_OK) esp_timer_start_periodic(th, 30ULL * 1000000ULL);

    ESP_LOGI(TAG, "gestartet -> %s (topic %s, discovery=%d)", uri, base, s_discovery);
}
