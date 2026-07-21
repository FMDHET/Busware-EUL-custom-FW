#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "board_config.h"

// Callback wird aufgerufen, sobald ein vollstaendiger ESP3-Frame (inkl. Sync,
// Header, CRC8H, Data, Optional, CRC8D) empfangen wurde. `frame`/`len` zeigen
// auf den kompletten Frame und sind nur innerhalb des Callbacks gueltig.
typedef void (*esp3_frame_cb_t)(const uint8_t *frame, size_t len, void *user);

typedef enum {
    ESP3_STATE_SYNC = 0,
    ESP3_STATE_HEADER,
    ESP3_STATE_CRC_HEADER,
    ESP3_STATE_DATA,
    ESP3_STATE_CRC_DATA,
} esp3_state_t;

typedef struct {
    esp3_state_t state;
    uint8_t  frame[EUL_ESP3_MAX_FRAME];
    size_t   pos;             // Bytes bisher im frame-Puffer
    uint16_t data_len;        // aus Header
    uint8_t  opt_len;         // aus Header
    size_t   body_expected;   // data_len + opt_len
    size_t   body_read;
    esp3_frame_cb_t cb;
    void    *user;
    // Statistik
    uint32_t frames_ok;
    uint32_t header_crc_err;
    uint32_t data_crc_err;
    uint32_t resyncs;
} esp3_parser_t;

// CRC8 nach EnOcean ESP3 (Polynom 0x07, Init 0x00, non-reflected).
uint8_t esp3_crc8(uint8_t crc, uint8_t data);
uint8_t esp3_crc8_buf(const uint8_t *buf, size_t len);

void esp3_parser_init(esp3_parser_t *p, esp3_frame_cb_t cb, void *user);
void esp3_parser_feed(esp3_parser_t *p, const uint8_t *data, size_t len);
