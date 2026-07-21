#include "esp3_parser.h"

#include <string.h>

#define ESP3_SYNC 0x55

uint8_t esp3_crc8(uint8_t crc, uint8_t data)
{
    crc ^= data;
    for (int i = 0; i < 8; i++) {
        crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
    }
    return crc;
}

uint8_t esp3_crc8_buf(const uint8_t *buf, size_t len)
{
    uint8_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        crc = esp3_crc8(crc, buf[i]);
    }
    return crc;
}

static void reset_parser(esp3_parser_t *p)
{
    p->state = ESP3_STATE_SYNC;
    p->pos = 0;
    p->data_len = 0;
    p->opt_len = 0;
    p->body_expected = 0;
    p->body_read = 0;
}

void esp3_parser_init(esp3_parser_t *p, esp3_frame_cb_t cb, void *user)
{
    memset(p, 0, sizeof(*p));
    p->cb = cb;
    p->user = user;
    reset_parser(p);
}

void esp3_parser_feed(esp3_parser_t *p, const uint8_t *data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        uint8_t b = data[i];

        switch (p->state) {
        case ESP3_STATE_SYNC:
            if (b == ESP3_SYNC) {
                p->pos = 0;
                p->frame[p->pos++] = b;
                p->state = ESP3_STATE_HEADER;
            }
            break;

        case ESP3_STATE_HEADER:
            p->frame[p->pos++] = b;
            // Header = 4 Byte nach Sync
            if (p->pos == 1 + 4) {
                p->data_len = ((uint16_t)p->frame[1] << 8) | p->frame[2];
                p->opt_len  = p->frame[3];
                p->body_expected = (size_t)p->data_len + (size_t)p->opt_len;
                // Sanity: passt der Frame ueberhaupt in unseren Puffer?
                // Gesamt = 1 (sync) + 4 (header) + 1 (crc8h) + body + 1 (crc8d)
                if (7u + p->body_expected > sizeof(p->frame)) {
                    p->resyncs++;
                    reset_parser(p);
                    break;
                }
                p->state = ESP3_STATE_CRC_HEADER;
            }
            break;

        case ESP3_STATE_CRC_HEADER: {
            uint8_t crc = esp3_crc8_buf(&p->frame[1], 4);
            p->frame[p->pos++] = b;
            if (b != crc) {
                p->header_crc_err++;
                p->resyncs++;
                // Byte war moeglicherweise selbst ein 0x55 -> zuruecksetzen und
                // dieses Byte nochmal betrachten. Fuer Einfachheit: neu suchen.
                reset_parser(p);
                break;
            }
            p->body_read = 0;
            if (p->body_expected == 0) {
                p->state = ESP3_STATE_CRC_DATA;
            } else {
                p->state = ESP3_STATE_DATA;
            }
            break;
        }

        case ESP3_STATE_DATA:
            p->frame[p->pos++] = b;
            p->body_read++;
            if (p->body_read >= p->body_expected) {
                p->state = ESP3_STATE_CRC_DATA;
            }
            break;

        case ESP3_STATE_CRC_DATA: {
            uint8_t crc = esp3_crc8_buf(&p->frame[6], p->body_expected);
            p->frame[p->pos++] = b;
            if (b != crc) {
                // Frame ist syntaktisch komplett aber Payload-CRC falsch.
                // Wir werfen ihn weg statt an TCM515 weiterzureichen.
                p->data_crc_err++;
            } else {
                p->frames_ok++;
                if (p->cb) {
                    p->cb(p->frame, p->pos, p->user);
                }
            }
            reset_parser(p);
            break;
        }
        }
    }
}
