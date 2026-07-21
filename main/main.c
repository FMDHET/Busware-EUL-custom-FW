// Busware EUL22 - Custom Firmware
//
// Ein Gateway zum TCM515 (EnOcean) mit zwei Betriebsmodi, die parallel aktiv
// sein koennen und im Portal umschaltbar sind:
//   * USB-CDC-Bridge (transparent, ESP3 direkt am USB)
//   * TCP-Bridge (Multi-Client, Token-Auth per Default) fuer Home Assistant
//
// Erststart / kein WiFi-Setup / Factory-Reset -> SoftAP mit generiertem WPA2-
// Passwort + Captive-Portal auf http://192.168.4.1/. Kein statisches Passwort,
// kein Default-Admin - CRA/RED-Anforderung.
//
// TODOs fuer Produktion (nicht Software-Scope):
//   * CE/RED-Testberichte (EMC, Safety)
//   * Secure Boot v2 + Flash Encryption (sdkconfig.defaults)
//   * OTA mit App-Signatur
//   * Vulnerability-Disclosure-Prozess dokumentieren

#include "board_config.h"
#include "mode_mgr.h"

#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

static const char *TAG = "eul-main";

static void led_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << EUL_PIN_LED,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io);
    gpio_set_level(EUL_PIN_LED, !EUL_LED_ACTIVE_LEVEL);
}

static void heartbeat_task(void *arg)
{
    while (1) {
        gpio_set_level(EUL_PIN_LED, EUL_LED_ACTIVE_LEVEL);
        vTaskDelay(pdMS_TO_TICKS(30));
        gpio_set_level(EUL_PIN_LED, !EUL_LED_ACTIVE_LEVEL);
        vTaskDelay(pdMS_TO_TICKS(1970));
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Busware EUL22 - custom firmware boot");
    led_init();
    xTaskCreate(heartbeat_task, "eul-hb", 1536, NULL, 3, NULL);
    ESP_ERROR_CHECK(mode_mgr_start());
}
