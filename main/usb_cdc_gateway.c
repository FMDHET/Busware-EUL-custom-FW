#include "usb_cdc_gateway.h"
#include "board_config.h"
#include "esp3_parser.h"
#include "enocean_uart.h"
#include "telemetry.h"

#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

static const char *TAG = "eul-usb";

static bool s_active = false;
static esp3_parser_t s_parser;

// Kompletter Frame aus USB -> UART (unter Mutex des enocean_uart-Layers).
static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    (void)user;
    telemetry_note_tx(frame, len);
    (void)enocean_uart_write_frame(frame, len);
}

static void usb_rx_task(void *arg)
{
    uint8_t buf[128];
    while (s_active) {
        int n = usb_serial_jtag_read_bytes(buf, sizeof(buf), pdMS_TO_TICKS(50));
        if (n > 0) {
            esp3_parser_feed(&s_parser, buf, (size_t)n);
        }
    }
    vTaskDelete(NULL);
}

esp_err_t usb_cdc_gateway_start(void)
{
    if (s_active) return ESP_OK;

    esp3_parser_init(&s_parser, on_frame, NULL);

    usb_serial_jtag_driver_config_t cfg = {
        .rx_buffer_size = 1024,
        .tx_buffer_size = 1024,
    };
    esp_err_t r = usb_serial_jtag_driver_install(&cfg);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "usb_serial_jtag install err=%d", r);
        return r;
    }

    s_active = true;
    xTaskCreate(usb_rx_task, "eul-usb-rx", 4096, NULL, 9, NULL);

    ESP_LOGW(TAG, "usb-cdc bridge active - silencing esp_log to keep esp3 stream clean");
    // Ab jetzt kein weiterer Log-Output auf USB, damit ESP3-Frames sauber laufen
    esp_log_level_set("*", ESP_LOG_NONE);
    return ESP_OK;
}

void usb_cdc_gateway_broadcast(const uint8_t *data, size_t len)
{
    if (!s_active || !data || len == 0) return;
    // KEINE Wartezeit: diese Funktion laeuft im UART-RX-Task. Haengt am USB
    // kein lesender Host (Kabel nur am Netzteil), laeuft der TX-Ring voll und
    // jedes Warten wuerde den RX-Task blockieren -> der UART-Eingangspuffer
    // laeuft ueber und EnOcean-Telegramme gehen verloren. Lieber die
    // USB-Ausgabe verwerfen als den Empfang zu gefaehrden.
    (void)usb_serial_jtag_write_bytes(data, len, 0);
}
