#pragma once

#include "sdkconfig.h"

// -----------------------------------------------------------------------------
// Busware EUL - Board Pin Map
// Quelle: schematics/EUL.pdf
// -----------------------------------------------------------------------------
// Alle laufzeit-relevanten Parameter (WiFi-Credentials, TCP-Port,
// Client-Zahl, mDNS-Name, ...) liegen in Kconfig.projbuild.
// -> "pio run -t menuconfig" -> Component config -> Busware EUL Gateway.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// TCM515-Ansteuerung (Busware EUL, ESP32-C3)
// -----------------------------------------------------------------------------
// Pins aus drei Quellen abgeleitet und verifiziert (E2E round-trip):
//
//   1) User-Info (Tasmota-Config):
//        Template: {"GPIO":[1,1,1,3840,544,1,1,1,1,1,1,0,...,5504,5472]}
//        Rule:     TCPBaudrate 57600; TCPStart 2325
//        Notiz:    GPIO 3=NRST, GPIO 10=BOOT, GPIO 9=LED, RX=20, TX=21
//
//   2) Busware-Original-FW:
//        github.com/tostmann/busware-esp32
//          - Simple/TCPBridge/src/main.ino:
//              TCMTransceiver Transceiver(&Serial0, 3, 5);   // (reset, turbo)
//          - lib/busware/busware.cpp::TCMTransceiver::begin():
//              if (_turboPIN) { digitalWrite(_turboPIN, LOW);
//                               _serial->begin(460800); }
//              else            _serial->begin(57600);
//          - variants/busware32c3/pins_arduino.h:
//              TX=21, RX=20, LED_BUILTIN=4, D1=3, D2=4, D3=5, D10=10
//
//   3) Schematic (schematics/EUL.pdf):
//        TCM515 pins 20 UART_RX, 21 UART_TX, 24 NRST, 27 PROG
//        R6=22R zwischen TCM515.TX und ESP32.U0RXD
//
// Konsequente Synthese:
//   - UART auf UART0-Default-Pins (matcht Tasmota SBR_RX/TX + busware Serial0)
//   - 460800 Baud + GPIO5 LOW: Busware-Turbo-Mode (verifiziert antwortet TCM
//     mit CO_RD_VERSION -> App 1.6.1.0, ChipID 042982b0, Desc "TCM515")
//   - Tasmota-Alternative waere 57600 ohne TURBO - beide Modi sind moeglich,
//     wir bleiben bei der Busware-Konvention weil das die dokumentierte FW-
//     Kompatibilitaets-Baseline ist
//   - GPIO 10 (BOOT/PROG per User-Info) wird von keiner der FWs aktiv
//     getrieben - internes TCM-Pull-Up haelt HIGH = Normal-Mode. Defensiv als
//     Input + Pull-Up konfigurieren.
// -----------------------------------------------------------------------------

#define EUL_UART_PORT        UART_NUM_0
#define EUL_UART_BAUD        460800
#define EUL_PIN_TCM_UART_TX  21    // ESP32.U0TXD -> TCM515 pin 20 UART_RX
#define EUL_PIN_TCM_UART_RX  20    // ESP32.U0RXD <- TCM515 pin 21 UART_TX (via R6=22R)

#define EUL_PIN_TCM_NRST     3     // -> TCM515 NRST     : LOW=held-in-reset, HIGH=run
#define EUL_PIN_TCM_TURBO    5     // -> TCM515 CFG      : LOW=460800 Baud (Turbo)
#define EUL_PIN_TCM_BOOT     10    // -> TCM515 PROG     : HIGH=normal, LOW=bootloader

// ---- User I/O ---------------------------------------------------------------
// Blaue LED auf GPIO 9 laut User-Tasmota-Info.
// Achtung: GPIO 9 ist auf ESP32-C3 gleichzeitig der BOOT-Strapping-Pin.
// Waehrend CPU-Reset muss GPIO 9 HIGH sein (internes Pull-Up haelt es),
// zur Laufzeit kann es frei als Output verwendet werden.
#define EUL_PIN_LED          9
#define EUL_LED_ACTIVE_LEVEL 0     // LED zieht gegen GND -> aktiv low

// ---- Buffer-Groessen -------------------------------------------------------
#define EUL_UART_RX_BUFFER   2048
#define EUL_UART_TX_BUFFER   1024

// Groesster erwarteter ESP3-Frame. 256 Byte reichen fuer alle in der Praxis
// vorkommenden Telegramme (VLD max 14 Byte payload).
#define EUL_ESP3_MAX_FRAME   256
