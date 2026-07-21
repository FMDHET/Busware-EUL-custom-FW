#include "mqtt_bridge.h"
#include "telemetry.h"
#include "enocean_uart.h"

#include <string.h>
#include <stdio.h>

#include "mqtt_client.h"
#include "esp_log.h"

static const char *TAG = "eul-mqtt";

static esp_mqtt_client_handle_t s_client;
static char s_topic_rx[80];
static char s_topic_send[80];

// Hex-String (mit beliebigen Trennern) -> Bytes.
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
        else continue;                       // Leerzeichen/Doppelpunkt ueberspringen
        if (hi < 0) { hi = v; }
        else        { out[n++] = (uint8_t)((hi << 4) | v); hi = -1; }
    }
    return n;
}

// Callback aus der Telemetrie: jedes empfangene Telegramm publishen.
static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    (void)user;
    if (!s_client) return;
    char json[256];
    int n = telemetry_frame_to_json(frame, len, json, sizeof(json));
    if (n > 0) esp_mqtt_client_publish(s_client, s_topic_rx, json, n, 0, 0);
}

static void mqtt_event_handler(void *args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    (void)args; (void)base;
    esp_mqtt_event_handle_t e = (esp_mqtt_event_handle_t)event_data;

    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED:
        esp_mqtt_client_subscribe(s_client, s_topic_send, 0);
        ESP_LOGI(TAG, "verbunden - publish %s, subscribe %s", s_topic_rx, s_topic_send);
        break;

    case MQTT_EVENT_DATA:
        // Kommando auf <base>/send: Payload als ESP3-Hex an den TCM515 senden.
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

void mqtt_bridge_start(const char *host, uint16_t port,
                       const char *user, const char *pass,
                       const char *base_topic)
{
    if (!host || !host[0]) {
        ESP_LOGW(TAG, "kein Broker-Host konfiguriert - MQTT nicht gestartet");
        return;
    }
    if (!base_topic || !base_topic[0]) base_topic = "eul22";
    snprintf(s_topic_rx,   sizeof(s_topic_rx),   "%s/rx",   base_topic);
    snprintf(s_topic_send, sizeof(s_topic_send), "%s/send", base_topic);

    char uri[96];
    snprintf(uri, sizeof(uri), "mqtt://%s:%u", host, port ? port : 1883);

    esp_mqtt_client_config_t cfg = {
        .broker.address.uri = uri,
    };
    if (user && user[0]) cfg.credentials.username = user;
    if (pass && pass[0]) cfg.credentials.authentication.password = pass;

    s_client = esp_mqtt_client_init(&cfg);
    if (!s_client) { ESP_LOGE(TAG, "mqtt init fehlgeschlagen"); return; }

    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    esp_mqtt_client_start(s_client);
    telemetry_set_frame_cb(on_frame, NULL);

    ESP_LOGI(TAG, "gestartet -> %s (topic %s)", uri, base_topic);
}
