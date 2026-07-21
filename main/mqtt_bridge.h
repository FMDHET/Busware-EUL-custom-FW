#pragma once

#include <stdint.h>

// Startet den MQTT-Client: publiziert empfangene Telegramme als JSON auf
// <base_topic>/rx und abonniert <base_topic>/send fuer Sende-Kommandos
// (Payload = ESP3-Frame als Hex). Nur im Normalmodus, WiFi muss stehen.
void mqtt_bridge_start(const char *host, uint16_t port,
                       const char *user, const char *pass,
                       const char *base_topic);
