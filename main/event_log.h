#pragma once

#include <stddef.h>
#include <stdint.h>

// Struktuierter Event-Ring fuer Debugging (Boot, WiFi, TCP-Clients, MQTT,
// Security, Config). Zusaetzlich zur Web-Konsole (Rohbytes) - hier stehen
// benannte Ereignisse mit Level/Tag/Uhrzeit. Wird auch auf ESP_LOG gespiegelt.

#define EVT_LEVEL_INFO 0
#define EVT_LEVEL_WARN 1
#define EVT_LEVEL_ERR  2

void event_log_init(void);

void event_log_add(int level, const char *tag, const char *fmt, ...)
    __attribute__((format(printf, 3, 4)));

// JSON-Array der Events mit seq > since_seq nach buf. last_seq = hoechste seq.
int event_log_dump_since(uint64_t since_seq, char *buf, size_t buf_size,
                         uint64_t *last_seq);

#define EVT_INFO(tag, ...) event_log_add(EVT_LEVEL_INFO, (tag), __VA_ARGS__)
#define EVT_WARN(tag, ...) event_log_add(EVT_LEVEL_WARN, (tag), __VA_ARGS__)
#define EVT_ERR(tag, ...)  event_log_add(EVT_LEVEL_ERR,  (tag), __VA_ARGS__)
