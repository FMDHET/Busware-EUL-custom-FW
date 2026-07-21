#include "captive_dns.h"

#include <string.h>
#include <errno.h>

#include "lwip/sockets.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

static const char *TAG = "eul-dns";

// DNS-Header (12 Byte, RFC 1035)
typedef struct __attribute__((packed)) {
    uint16_t id;
    uint16_t flags;
    uint16_t qdcount;
    uint16_t ancount;
    uint16_t nscount;
    uint16_t arcount;
} dns_hdr_t;

static uint32_t s_ap_ip_be = 0;

static void dns_task(void *arg)
{
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "socket err=%d", errno);
        vTaskDelete(NULL);
    }
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = htonl(INADDR_ANY),
        .sin_port = htons(53),
    };
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "bind err=%d", errno);
        close(sock);
        vTaskDelete(NULL);
    }
    ESP_LOGI(TAG, "captive dns on udp/53");

    uint8_t buf[256];
    while (1) {
        struct sockaddr_in from;
        socklen_t fl = sizeof(from);
        int n = recvfrom(sock, buf, sizeof(buf), 0, (struct sockaddr *)&from, &fl);
        if (n < (int)sizeof(dns_hdr_t)) continue;

        // Reply zusammenbauen. Wir kopieren die Query zurueck und haengen
        // ein einzelnes A-Record mit AP-IP an. Nur QDCOUNT=1 wird bedient.
        dns_hdr_t *h = (dns_hdr_t *)buf;
        if (ntohs(h->qdcount) != 1) continue;

        // Reply flags: QR=1, OPCODE=0, AA=1, RCODE=0
        h->flags   = htons(0x8180);
        h->ancount = htons(1);

        // Question durchparsen um Ende zu finden
        int i = sizeof(dns_hdr_t);
        while (i < n && buf[i] != 0) {
            if (buf[i] & 0xC0) break;      // kein pointer erwartet in Query
            i += buf[i] + 1;
        }
        i += 1 + 4; // NUL + qtype(2) + qclass(2)
        if (i + 16 > (int)sizeof(buf)) continue;

        // Answer: name-pointer auf question (offset 12), type A, class IN,
        // TTL 60, rdlength 4, rdata=IP
        buf[i++] = 0xC0; buf[i++] = 0x0C;      // pointer 0x0C = 12
        buf[i++] = 0x00; buf[i++] = 0x01;      // TYPE A
        buf[i++] = 0x00; buf[i++] = 0x01;      // CLASS IN
        buf[i++] = 0x00; buf[i++] = 0x00; buf[i++] = 0x00; buf[i++] = 60; // TTL 60
        buf[i++] = 0x00; buf[i++] = 0x04;      // RDLENGTH
        memcpy(&buf[i], &s_ap_ip_be, 4);
        i += 4;

        sendto(sock, buf, i, 0, (struct sockaddr *)&from, fl);
    }
}

esp_err_t captive_dns_start(const char *ap_ip_str)
{
    if (inet_aton(ap_ip_str, (struct in_addr *)&s_ap_ip_be) == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    xTaskCreate(dns_task, "eul-dns", 3072, NULL, 5, NULL);
    return ESP_OK;
}
