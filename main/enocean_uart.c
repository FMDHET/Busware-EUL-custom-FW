#include "enocean_uart.h"
#include "board_config.h"
#include "esp3_parser.h"
#include "console_log.h"

#include "driver/uart.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"

#include <string.h>

static const char *TAG = "eul-uart";

static SemaphoreHandle_t s_tx_mutex;
static enocean_rx_cb_t   s_rx_cb;
static void             *s_rx_user;

// Observer-Parser fuer eingehende Bytes vom TCM515 - zaehlt Frames und
// speist die Web-Konsole. Aendert NICHTS am Weiterleiten der Rohbytes.
static esp3_parser_t s_rx_observer;

static uint64_t s_rx_bytes;
static uint64_t s_tx_bytes;
static uint32_t s_rx_frames;
static uint32_t s_tx_frames;

static void observer_on_frame(const uint8_t *frame, size_t len, void *user)
{
    (void)user;
    s_rx_frames++;
    console_log_frame_tcm(frame, len);
}

uint64_t enocean_uart_rx_bytes(void)  { return s_rx_bytes;  }
uint64_t enocean_uart_tx_bytes(void)  { return s_tx_bytes;  }
uint32_t enocean_uart_rx_frames(void) { return s_rx_frames; }
uint32_t enocean_uart_tx_frames(void) { return s_tx_frames; }

static void tcm515_hw_init(void)
{
    // Sequenz aus busware.cpp/TCMTransceiver::begin() + defensiver BOOT-Pin:
    //   1. NRST als Output, LOW (Modul in Reset)
    //   2. TURBO als Output, LOW (Turbo-Mode aktiv -> 460800 Baud)
    //   3. BOOT als Input+Pull-Up (Normal-Mode, kein Bootloader)
    //   4. UART auf 460800 Baud konfigurieren
    //   5. NRST HIGH -> TCM bootet, Boot-Delay ~300ms
    gpio_config_t out = {
        .pin_bit_mask = (1ULL << EUL_PIN_TCM_NRST) | (1ULL << EUL_PIN_TCM_TURBO),
        .mode         = GPIO_MODE_OUTPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    gpio_config(&out);

    gpio_config_t boot_in = {
        .pin_bit_mask = (1ULL << EUL_PIN_TCM_BOOT),
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    gpio_config(&boot_in);

    gpio_set_level(EUL_PIN_TCM_NRST,  0);
    gpio_set_level(EUL_PIN_TCM_TURBO, 0);
    vTaskDelay(pdMS_TO_TICKS(20));

    gpio_set_level(EUL_PIN_TCM_NRST, 1);
    vTaskDelay(pdMS_TO_TICKS(300));
}

static void rx_task(void *arg)
{
    uint8_t buf[128];
    while (1) {
        int n = uart_read_bytes(EUL_UART_PORT, buf, sizeof(buf), pdMS_TO_TICKS(20));
        if (n > 0) {
            s_rx_bytes += (uint64_t)n;
            if (s_rx_cb) s_rx_cb(buf, (size_t)n, s_rx_user);
            esp3_parser_feed(&s_rx_observer, buf, (size_t)n);
        }
    }
}

esp_err_t enocean_uart_start(void)
{
    s_tx_mutex = xSemaphoreCreateMutex();
    if (!s_tx_mutex) {
        return ESP_ERR_NO_MEM;
    }
    esp3_parser_init(&s_rx_observer, observer_on_frame, NULL);

    ESP_LOGI(TAG, "TCM515 init: NRST=GPIO%d TURBO=GPIO%d BOOT=GPIO%d",
             EUL_PIN_TCM_NRST, EUL_PIN_TCM_TURBO, EUL_PIN_TCM_BOOT);
    tcm515_hw_init();

    const uart_config_t cfg = {
        .baud_rate  = EUL_UART_BAUD,
        .data_bits  = UART_DATA_8_BITS,
        .parity     = UART_PARITY_DISABLE,
        .stop_bits  = UART_STOP_BITS_1,
        .flow_ctrl  = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(EUL_UART_PORT,
                                        EUL_UART_RX_BUFFER,
                                        EUL_UART_TX_BUFFER,
                                        0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(EUL_UART_PORT, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(EUL_UART_PORT,
                                 EUL_PIN_TCM_UART_TX,
                                 EUL_PIN_TCM_UART_RX,
                                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

    xTaskCreate(rx_task, "eul-uart-rx", 3072, NULL, 12, NULL);

    ESP_LOGI(TAG, "UART %d ready @%d bps (RX=GPIO%d TX=GPIO%d)",
             EUL_UART_PORT, EUL_UART_BAUD,
             EUL_PIN_TCM_UART_RX, EUL_PIN_TCM_UART_TX);
    return ESP_OK;
}

esp_err_t enocean_uart_write_frame(const uint8_t *frame, size_t len)
{
    if (!frame || len == 0) return ESP_ERR_INVALID_ARG;

    if (xSemaphoreTake(s_tx_mutex, pdMS_TO_TICKS(500)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    int written = uart_write_bytes(EUL_UART_PORT, (const char *)frame, len);
    xSemaphoreGive(s_tx_mutex);

    if (written == (int)len) {
        s_tx_bytes  += (uint64_t)len;
        s_tx_frames += 1;
        return ESP_OK;
    }
    return ESP_FAIL;
}

void enocean_uart_set_rx_cb(enocean_rx_cb_t cb, void *user)
{
    s_rx_cb = cb;
    s_rx_user = user;
}
