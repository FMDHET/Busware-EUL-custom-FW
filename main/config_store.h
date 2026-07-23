#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define EUL_WIFI_SSID_MAX      33
#define EUL_WIFI_PASS_MAX      65
#define EUL_AP_PASS_LEN        12    // WPA2-PSK muss >= 8, wir nehmen 12
#define EUL_AP_PASS_MAX        (EUL_AP_PASS_LEN + 1)
#define EUL_ADMIN_PASS_LEN     12
#define EUL_ADMIN_PASS_MAX     (EUL_ADMIN_PASS_LEN + 1)
#define EUL_TCP_TOKEN_LEN      32
#define EUL_TCP_TOKEN_MAX      (EUL_TCP_TOKEN_LEN + 1)

#define EUL_DEV_NAME_MAX       40
#define EUL_ADMIN_USER_MAX     24
#define EUL_NTP_MAX            64
#define EUL_TZ_MAX             48

typedef struct {
    bool     provisioned;                    // WiFi-Setup abgeschlossen?
    bool     usb_enabled;                    // USB-CDC-Bridge aktiv?
    bool     tcp_enabled;                    // TCP-Bridge aktiv?
    bool     tcp_auth_required;              // AUTH-Handshake erzwingen?
    uint16_t tcp_port;

    // Allgemein
    char     device_name[EUL_DEV_NAME_MAX];  // Anzeigename (Portal, HA, mDNS)
    char     admin_user[EUL_ADMIN_USER_MAX]; // Portal-Login-Benutzer (Default admin)
    char     ntp_server[EUL_NTP_MAX];        // SNTP-Server (Default pool.ntp.org)
    char     tz[EUL_TZ_MAX];                 // POSIX-TZ-String (Default Europe/Berlin)

    // REST-API (lesen/senden per HTTP, Auth ueber tcp_token)
    bool     api_enabled;

    char     wifi_ssid[EUL_WIFI_SSID_MAX];
    char     wifi_pass[EUL_WIFI_PASS_MAX];

    // Feste IP (optional, statt DHCP)
    bool     wifi_static;
    char     ip_addr[16];
    char     ip_gw[16];
    char     ip_mask[16];
    char     ip_dns[16];

    // Pro-Geraet Zufallswerte (bei Factory-Init einmal generiert)
    char     ap_pass[EUL_AP_PASS_MAX];       // SoftAP WPA2 Passphrase
    char     admin_pass[EUL_ADMIN_PASS_MAX]; // Portal-Login im STA-Modus
    char     tcp_token[EUL_TCP_TOKEN_MAX];   // AUTH-Token fuer TCP-Clients + REST-API
} eul_config_t;

// Laedt Config aus NVS. Bei fehlendem Namespace / erstem Boot werden
// Zufalls-Credentials generiert und persistiert; provisioned bleibt false
// bis der User WiFi-Daten setzt. Fuehrt auch Sanity-Checks aus (siehe .c).
esp_err_t config_load(eul_config_t *out);

// -----------------------------------------------------------------------------
// Feinkoernige Setter - jeder Aufruf beruehrt AUSSCHLIESSLICH seine eigenen
// NVS-Keys. So kann ein Bug in einem Pfad keine anderen Config-Bereiche
// beschaedigen. Insbesondere: WiFi-Credentials bleiben unangetastet, wenn
// nur Modi oder Secrets geaendert werden.
// -----------------------------------------------------------------------------

// Schreibt WiFi-Credentials + provisioned-Flag atomar (ein NVS-commit).
// Beide Argumente muessen non-empty sein - sonst ESP_ERR_INVALID_ARG.
// Semantik: WiFi-Creds werden immer paarweise gesetzt, nie halb.
esp_err_t config_save_wifi(const char *ssid, const char *pass);

// Schreibt nur Modi/Port/Auth-Flags.
esp_err_t config_save_modes(bool usb_enabled,
                             bool tcp_enabled,
                             bool tcp_auth_required,
                             uint16_t tcp_port);

// Schreibt die feste-IP-Einstellung (nur diese Keys). enabled=false -> DHCP.
esp_err_t config_save_netip(bool wifi_static, const char *ip, const char *gw,
                            const char *mask, const char *dns);

// Schreibt Allgemein-Einstellungen (Name, Login-User, NTP-Server, Zeitzone).
esp_err_t config_save_general(const char *device_name,
                               const char *admin_user,
                               const char *ntp_server,
                               const char *tz);

// Schreibt die REST-API-Einstellung (nur dieser Key).
esp_err_t config_save_integrations(bool api_enabled);

// Erzeugt einen frischen TCP-Auth-Token, persistiert nur diesen Key.
esp_err_t config_regen_tcp_token(char *out, size_t out_size);

// Setzt ein neues Admin-Passwort (Portal, STA-Modus), persistiert nur diesen Key.
esp_err_t config_set_admin_pass(const char *new_pass);

// Loescht NVS-Namespace komplett. Naechster Boot ist "as-shipped".
esp_err_t config_factory_reset(void);

// Liefert die 6-stellige MAC-Suffix in HEX (z.B. "A1B2C3"). Wird fuer
// AP-SSID und mDNS-Hostname genutzt und ist beim ersten Aufruf initialisiert.
const char *config_device_suffix(void);
