#pragma once

#include <stdint.h>
#include <stdbool.h>

typedef struct {
    const char *host;
    uint16_t    port;
    const char *user;
    const char *pass;
    const char *base_topic;    // Basis-Topic (z.B. "eul22/xxxxxx")
    const char *device_name;   // Anzeigename fuer HA (leer -> Default)
    const char *suffix;        // MAC-Suffix, fuer eindeutige HA-IDs
    bool        discovery;     // HA MQTT-Autodiscovery
    const char *disc_prefix;   // Discovery-Prefix (homeassistant)
    bool        retain;        // State-Messages mit retain publizieren
} mqtt_bridge_cfg_t;

// Startet den MQTT-Client. Publiziert empfangene Telegramme (<base>/rx und
// <base>/dev/<sender>), abonniert <base>/send (Hex-Frame), setzt LWT auf
// <base>/status und - falls discovery - HA-Discovery fuer Gateway + Sender.
void mqtt_bridge_start(const mqtt_bridge_cfg_t *cfg);
