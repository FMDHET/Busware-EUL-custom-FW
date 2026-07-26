#include "http_portal.h"
#include "portal_html.h"
#include "config_store.h"
#include "security.h"
#include "mode_mgr.h"
#include "tcp_server.h"
#include "enocean_uart.h"
#include "console_log.h"
#include "event_log.h"
#include "telemetry.h"
#include "version.h"
#include "sdkconfig.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>

#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_ota_ops.h"
#include "wifi_sta.h"

#include "mbedtls/base64.h"
#include "cJSON.h"

static const char *TAG = "eul-http";
static bool s_ap_mode = false;

// Vorwaerts-Deklaration: Hex-String -> Bytes (Definition weiter unten).
static size_t parse_hex_str(const char *s, uint8_t *out, size_t outcap);

// -----------------------------------------------------------------------------
// Basic-Auth-Check (nur im STA-Modus). CRA: kein statisches Default-Passwort,
// der Wert kommt aus config_store und ist pro Geraet zufaellig.
// -----------------------------------------------------------------------------
static bool check_basic_auth(httpd_req_t *req, const eul_config_t *cfg)
{
    if (s_ap_mode) return true;

    char hdr[128];
    if (httpd_req_get_hdr_value_str(req, "Authorization", hdr, sizeof(hdr)) != ESP_OK) {
        goto deny;
    }
    if (strncmp(hdr, "Basic ", 6) != 0) goto deny;

    unsigned char dec[128];
    size_t dec_len = 0;
    if (mbedtls_base64_decode(dec, sizeof(dec) - 1, &dec_len,
                              (const unsigned char *)hdr + 6, strlen(hdr + 6)) != 0) {
        goto deny;
    }
    dec[dec_len] = 0;

    char expected[96];
    const char *user = (cfg->admin_user[0]) ? cfg->admin_user : "admin";
    snprintf(expected, sizeof(expected), "%s:%s", user, cfg->admin_pass);

    if (sec_constant_time_equal((const char *)dec, expected)) return true;

    sec_event("portal_auth_fail", "wrong basic auth");
deny:
    httpd_resp_set_status(req, "401 Unauthorized");
    httpd_resp_set_hdr(req, "WWW-Authenticate", "Basic realm=\"EUL\"");
    httpd_resp_sendstr(req, "auth required");
    return false;
}

static bool require_auth(httpd_req_t *req)
{
    eul_config_t cfg;
    if (config_load(&cfg) != ESP_OK) {
        // Ohne Antwort haenge der Client bis zum Socket-Timeout.
        httpd_resp_send_500(req);
        return false;
    }
    return check_basic_auth(req, &cfg);
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------
static esp_err_t h_root(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_send(req, PORTAL_HTML, HTTPD_RESP_USE_STRLEN);
}

// Umleitungs-Handler fuer Captive-Portal-Erkennung (Android / iOS / Windows)
static esp_err_t h_captive(httpd_req_t *req)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "/");
    return httpd_resp_send(req, NULL, 0);
}

static esp_err_t h_state(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    eul_config_t cfg;
    if (config_load(&cfg) != ESP_OK) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "mode", s_ap_mode ? "provisioning" : "normal");
    cJSON_AddStringToObject(root, "suffix", config_device_suffix());
    cJSON_AddStringToObject(root, "wifi_ssid", cfg.wifi_ssid);
    cJSON_AddBoolToObject(root, "wifi_static", cfg.wifi_static);
    cJSON_AddStringToObject(root, "ip_addr",   cfg.ip_addr);
    cJSON_AddStringToObject(root, "ip_gw",     cfg.ip_gw);
    cJSON_AddStringToObject(root, "ip_mask",   cfg.ip_mask);
    cJSON_AddStringToObject(root, "ip_dns",    cfg.ip_dns);
    cJSON_AddBoolToObject(root, "usb_enabled",       cfg.usb_enabled);
    cJSON_AddBoolToObject(root, "tcp_enabled",       cfg.tcp_enabled);
    cJSON_AddNumberToObject(root, "tcp_port",        cfg.tcp_port);
    cJSON_AddBoolToObject(root, "tcp_auth_required", cfg.tcp_auth_required);
    cJSON_AddStringToObject(root, "tcp_token",       cfg.tcp_token);
    cJSON_AddStringToObject(root, "ota_token",       cfg.ota_token);
    cJSON_AddBoolToObject(root, "api_enabled",   cfg.api_enabled);
    cJSON_AddStringToObject(root, "device_name", cfg.device_name);
    cJSON_AddStringToObject(root, "fw_version", EUL_FW_VERSION);
    cJSON_AddNumberToObject(root, "fw_build",   EUL_FW_BUILD);
    cJSON_AddStringToObject(root, "fw_git",     EUL_FW_GIT);
    cJSON_AddStringToObject(root, "fw_date",    EUL_FW_DATE);
    {
        const esp_partition_t *run = esp_ota_get_running_partition();
        cJSON_AddStringToObject(root, "fw_part", run ? run->label : "?");
    }
    cJSON_AddStringToObject(root, "admin_user",  cfg.admin_user);
    cJSON_AddStringToObject(root, "ntp_server",  cfg.ntp_server);
    cJSON_AddStringToObject(root, "tz",          cfg.tz);
    // WLAN-Passwort nur im STA-Modus ausliefern (dort schuetzt Basic-Auth
    // das Portal), damit der Nutzer sein gespeichertes Passwort ansehen kann.
    // Im offenen AP-Modus (Erst-Setup) niemals Secrets herausgeben.
    cJSON_AddStringToObject(root, "wifi_pass", s_ap_mode ? "" : cfg.wifi_pass);
    // Admin-Pass nur im AP-Modus einmalig anzeigen. Im STA nur Platzhalter.
    cJSON_AddStringToObject(root, "admin_pass",
                            s_ap_mode ? cfg.admin_pass : "");

    char *out = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!out) { httpd_resp_send_500(req); return ESP_FAIL; }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, out);
    free(out);
    return ESP_OK;
}

static esp_err_t h_scan(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;

    wifi_scan_config_t sc = {0};
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) {
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_sendstr(req, "[]");
    }
    uint16_t ap_num = 0;
    esp_wifi_scan_get_ap_num(&ap_num);
    if (ap_num == 0) {
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_sendstr(req, "[]");
    }
    if (ap_num > 20) ap_num = 20;
    wifi_ap_record_t *aps = calloc(ap_num, sizeof(*aps));
    if (!aps) { httpd_resp_send_500(req); return ESP_FAIL; }
    esp_wifi_scan_get_ap_records(&ap_num, aps);

    cJSON *arr = cJSON_CreateArray();
    for (int i = 0; i < ap_num; i++) {
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "ssid", (char *)aps[i].ssid);
        cJSON_AddNumberToObject(o, "rssi", aps[i].rssi);
        const char *am = "open";
        switch (aps[i].authmode) {
            case WIFI_AUTH_WEP:            am = "wep"; break;
            case WIFI_AUTH_WPA_PSK:        am = "wpa"; break;
            case WIFI_AUTH_WPA2_PSK:       am = "wpa2"; break;
            case WIFI_AUTH_WPA_WPA2_PSK:   am = "wpa/wpa2"; break;
            case WIFI_AUTH_WPA3_PSK:       am = "wpa3"; break;
            case WIFI_AUTH_WPA2_WPA3_PSK:  am = "wpa2/wpa3"; break;
            default: break;
        }
        cJSON_AddStringToObject(o, "auth", am);
        cJSON_AddItemToArray(arr, o);
    }
    free(aps);

    char *out = cJSON_PrintUnformatted(arr);
    cJSON_Delete(arr);
    if (!out) { httpd_resp_send_500(req); return ESP_FAIL; }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, out);
    free(out);
    return ESP_OK;
}

#define EUL_MAX_BODY 4096

// Prueft die Body-Groesse VOR dem Lesen und beantwortet Verstoesse selbst mit
// 400. Ohne das lieferte ein leerer oder zu grosser Body ein irrefuehrendes 500.
// Rueckgabe: true = Groesse ok, false = Antwort wurde bereits gesendet.
static bool body_size_ok(httpd_req_t *req)
{
    if (req->content_len == 0) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "leerer Body");
        return false;
    }
    if (req->content_len > EUL_MAX_BODY) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "Body zu gross (max. 4096 Byte)");
        return false;
    }
    return true;
}

static char *read_body(httpd_req_t *req)
{
    size_t total = req->content_len;
    if (total == 0 || total > EUL_MAX_BODY) return NULL;
    char *buf = malloc(total + 1);
    if (!buf) return NULL;
    size_t got = 0;
    while (got < total) {
        int r = httpd_req_recv(req, buf + got, total - got);
        if (r <= 0) { free(buf); return NULL; }
        got += r;
    }
    buf[got] = 0;
    return buf;
}

static void schedule_reboot(void)
{
    // Nicht direkt aus dem HTTP-Handler restarten - dem Client noch die
    // Antwort schicken lassen. Deshalb 500 ms warten in einem Task.
    mode_mgr_schedule_reboot(500);
}

static esp_err_t h_config(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    if (!body_size_ok(req)) return ESP_OK;
    char *body = read_body(req);
    if (!body) { httpd_resp_send_500(req); return ESP_FAIL; }

    cJSON *j = cJSON_Parse(body);
    free(body);
    if (!j) { httpd_resp_set_status(req, "400 Bad Request"); httpd_resp_sendstr(req, "bad json"); return ESP_OK; }

    // Aktuellen Zustand laden - wir kennen dann alle Modi-Defaults fuer den
    // Fall, dass der Client nur ein Subset schickt.
    eul_config_t cur;
    if (config_load(&cur) != ESP_OK) {
        cJSON_Delete(j); httpd_resp_send_500(req); return ESP_FAIL;
    }

    const cJSON *ssid = cJSON_GetObjectItem(j, "wifi_ssid");
    const cJSON *pass = cJSON_GetObjectItem(j, "wifi_pass");
    const cJSON *usb  = cJSON_GetObjectItem(j, "usb_enabled");
    const cJSON *tcp  = cJSON_GetObjectItem(j, "tcp_enabled");
    const cJSON *ta   = cJSON_GetObjectItem(j, "tcp_auth_required");
    const cJSON *port = cJSON_GetObjectItem(j, "tcp_port");

    // Port validieren BEVOR irgendetwas gespeichert wird: 1..65535, und nicht
    // 80 (dort laeuft das Portal - eine Kollision macht beides unbrauchbar).
    if (port && cJSON_IsNumber(port) &&
        (port->valueint < 1 || port->valueint > 65535 || port->valueint == 80)) {
        cJSON_Delete(j);
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "tcp_port must be 1..65535 (not 80)");
        return ESP_OK;
    }

    // Stringlaengen gegen die NVS-Feldgroessen pruefen. Ohne das landet ein zu
    // langer Wert zwar im NVS, wird beim naechsten config_load aber als leer
    // gelesen - ein zu langes WLAN-Passwort wuerde das Geraet so beim naechsten
    // Boot kommentarlos in den AP-Modus zurueckfallen lassen.
    static const struct { const char *key; size_t max; } LIMITS[] = {
        { "wifi_ssid",   EUL_WIFI_SSID_MAX  - 1 },
        { "wifi_pass",   EUL_WIFI_PASS_MAX  - 1 },
        { "device_name", EUL_DEV_NAME_MAX   - 1 },
        { "admin_user",  EUL_ADMIN_USER_MAX - 1 },
        { "admin_pass",  EUL_ADMIN_PASS_MAX - 1 },
        { "ntp_server",  EUL_NTP_MAX        - 1 },
        { "tz",          EUL_TZ_MAX         - 1 },
        { "ip_addr", 15 }, { "ip_gw", 15 }, { "ip_mask", 15 }, { "ip_dns", 15 },
    };
    for (size_t i = 0; i < sizeof(LIMITS) / sizeof(LIMITS[0]); i++) {
        const cJSON *it = cJSON_GetObjectItem(j, LIMITS[i].key);
        if (it && cJSON_IsString(it) && it->valuestring &&
            strlen(it->valuestring) > LIMITS[i].max) {
            char msg[96];
            snprintf(msg, sizeof(msg), "%s ist zu lang (max. %u Zeichen)",
                     LIMITS[i].key, (unsigned)LIMITS[i].max);
            cJSON_Delete(j);
            httpd_resp_set_status(req, "400 Bad Request");
            httpd_resp_sendstr(req, msg);
            return ESP_OK;
        }
    }

    // WiFi-Credentials NUR paarweise und NUR wenn wirklich neue Werte
    // geliefert wurden. Sonst bleiben SSID und PW im NVS unangetastet.
    bool ssid_set = ssid && cJSON_IsString(ssid) && ssid->valuestring && ssid->valuestring[0];
    bool pass_set = pass && cJSON_IsString(pass) && pass->valuestring && pass->valuestring[0];

    if (ssid_set && pass_set) {
        esp_err_t rw = config_save_wifi(ssid->valuestring, pass->valuestring);
        if (rw != ESP_OK) {
            cJSON_Delete(j); httpd_resp_send_500(req); return ESP_FAIL;
        }
    } else if (ssid_set != pass_set) {
        // Nur eine Haelfte -> ablehnen, keine halben WiFi-Creds ins NVS.
        sec_event("wifi_pair_reject",
                  "portal sent ssid=%s pass=%s - refusing partial update",
                  ssid_set ? "yes" : "no", pass_set ? "yes" : "no");
        cJSON_Delete(j);
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "wifi_ssid and wifi_pass must be set together (or both omitted)");
        return ESP_OK;
    }
    // else: keine WiFi-Aenderung - alles bleibt wie es ist.

    esp_err_t rm = config_save_modes(
        (usb  && cJSON_IsBool(usb))    ? cJSON_IsTrue(usb) : cur.usb_enabled,
        (tcp  && cJSON_IsBool(tcp))    ? cJSON_IsTrue(tcp) : cur.tcp_enabled,
        (ta   && cJSON_IsBool(ta))     ? cJSON_IsTrue(ta)  : cur.tcp_auth_required,
        (port && cJSON_IsNumber(port)) ? (uint16_t)port->valueint : cur.tcp_port);

    // Allgemein: Geraetename, Login-Benutzer, NTP-Server.
    const cJSON *dev_name = cJSON_GetObjectItem(j, "device_name");
    const cJSON *adm_user = cJSON_GetObjectItem(j, "admin_user");
    const cJSON *ntp_srv  = cJSON_GetObjectItem(j, "ntp_server");
    const cJSON *tz       = cJSON_GetObjectItem(j, "tz");
    esp_err_t rg = config_save_general(
        (dev_name && cJSON_IsString(dev_name)) ? dev_name->valuestring : cur.device_name,
        (adm_user && cJSON_IsString(adm_user) && adm_user->valuestring[0]) ? adm_user->valuestring : cur.admin_user,
        (ntp_srv  && cJSON_IsString(ntp_srv)  && ntp_srv->valuestring[0])  ? ntp_srv->valuestring  : cur.ntp_server,
        (tz       && cJSON_IsString(tz)       && tz->valuestring[0])       ? tz->valuestring       : cur.tz);

    // Neues Portal-Passwort nur wenn geliefert (>=8 Zeichen), sonst unveraendert.
    const cJSON *adm_pass = cJSON_GetObjectItem(j, "admin_pass");
    if (adm_pass && cJSON_IsString(adm_pass) && adm_pass->valuestring && strlen(adm_pass->valuestring) >= 8) {
        (void)config_set_admin_pass(adm_pass->valuestring);
    }

    // REST-API.
    const cJSON *api_en = cJSON_GetObjectItem(j, "api_enabled");
    esp_err_t ri = config_save_integrations(
        (api_en && cJSON_IsBool(api_en)) ? cJSON_IsTrue(api_en) : cur.api_enabled);

    // Feste IP (DHCP vs statisch).
    const cJSON *ip_st = cJSON_GetObjectItem(j, "wifi_static");
    const cJSON *ip_a  = cJSON_GetObjectItem(j, "ip_addr");
    const cJSON *ip_g  = cJSON_GetObjectItem(j, "ip_gw");
    const cJSON *ip_m  = cJSON_GetObjectItem(j, "ip_mask");
    const cJSON *ip_d  = cJSON_GetObjectItem(j, "ip_dns");
    esp_err_t rn = config_save_netip(
        (ip_st && cJSON_IsBool(ip_st))  ? cJSON_IsTrue(ip_st) : cur.wifi_static,
        (ip_a && cJSON_IsString(ip_a))  ? ip_a->valuestring : cur.ip_addr,
        (ip_g && cJSON_IsString(ip_g))  ? ip_g->valuestring : cur.ip_gw,
        (ip_m && cJSON_IsString(ip_m))  ? ip_m->valuestring : cur.ip_mask,
        (ip_d && cJSON_IsString(ip_d))  ? ip_d->valuestring : cur.ip_dns);

    cJSON_Delete(j);

    if (rm != ESP_OK || ri != ESP_OK || rg != ESP_OK || rn != ESP_OK) { httpd_resp_send_500(req); return ESP_FAIL; }
    sec_event("config_change", "applied via portal");
    // Speichern OHNE Neustart - Reboot ist ein eigener Button (/api/reboot).
    httpd_resp_sendstr(req, "{\"ok\":true}");
    return ESP_OK;
}

static esp_err_t h_regen_token(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    char tok[EUL_TCP_TOKEN_MAX];
    if (config_regen_tcp_token(tok, sizeof(tok)) != ESP_OK) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    // Laufende TCP-Bridge sofort auf den neuen Token umstellen, sonst bliebe
    // der alte bis zum Neustart gueltig.
    tcp_server_set_token(tok);
    char reply[128];
    snprintf(reply, sizeof(reply), "{\"token\":\"%s\"}", tok);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, reply);
}

// POST /api/regen-ota-token -> neuer OTA-Token (Basic-Auth; der alte Token
// verliert sofort seine Gueltigkeit).
static esp_err_t h_regen_ota_token(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    char tok[EUL_TCP_TOKEN_MAX];
    if (config_regen_ota_token(tok, sizeof(tok)) != ESP_OK) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    char reply[128];
    snprintf(reply, sizeof(reply), "{\"token\":\"%s\"}", tok);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, reply);
}

static esp_err_t h_factory(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    if (config_factory_reset() != ESP_OK) {
        // NVS-Wipe fehlgeschlagen -> NICHT rebooten, sonst kommt das Geraet
        // mit alter Config wieder hoch und der Nutzer wundert sich.
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    httpd_resp_sendstr(req, "{\"ok\":true}");
    schedule_reboot();
    return ESP_OK;
}

static esp_err_t h_reboot(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    httpd_resp_sendstr(req, "{\"ok\":true}");
    schedule_reboot();
    return ESP_OK;
}

// GET /api/clients -> JSON-Array der aktiven TCP-Clients
static esp_err_t h_clients(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    char buf[1024];
    int n = tcp_server_dump_clients_json(buf, sizeof(buf));
    if (n < 0) { httpd_resp_send_500(req); return ESP_FAIL; }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, buf, n);
}

// GET /api/stats -> globale Statistik (TCM515 + Client-Count)
static esp_err_t h_stats(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;

    // Aktueller WLAN-Zustand fuer den Status-Reiter: RSSI (Signalstaerke),
    // zugewiesene IP und Uptime. RSSI/IP sind nur im STA-Modus gueltig.
    int rssi = 0;
    if (esp_wifi_sta_get_rssi(&rssi) != ESP_OK) rssi = 0;
    const char *ip = wifi_sta_ip_str();

    // Echte Uhrzeit (epoch ms) fuer die Telegramm-Zeitstempel. 0 solange SNTP
    // noch nicht synchronisiert hat (Jahr < 2020) -> Frontend faellt dann auf
    // Uptime-Sekunden zurueck.
    struct timeval tv;
    gettimeofday(&tv, NULL);
    long long epoch_ms = (tv.tv_sec > 1700000000LL)
        ? ((long long)tv.tv_sec * 1000 + tv.tv_usec / 1000) : 0;

    char buf[448];
    int n = snprintf(buf, sizeof(buf),
        "{\"clients\":%d,"
        "\"tcm_rx_bytes\":%llu,\"tcm_tx_bytes\":%llu,"
        "\"tcm_rx_frames\":%u,\"tcm_tx_frames\":%u,"
        "\"ip\":\"%s\",\"rssi\":%d,\"uptime_ms\":%llu,\"epoch_ms\":%lld,"
        "\"heap_free\":%u,\"heap_max\":%u}",
        tcp_server_active_clients(),
        (unsigned long long)enocean_uart_rx_bytes(),
        (unsigned long long)enocean_uart_tx_bytes(),
        (unsigned)enocean_uart_rx_frames(),
        (unsigned)enocean_uart_tx_frames(),
        ip ? ip : "",
        rssi,
        (unsigned long long)(esp_timer_get_time() / 1000),
        epoch_ms,
        (unsigned)esp_get_free_heap_size(),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT));
    if (n < 0) { httpd_resp_send_500(req); return ESP_FAIL; }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, buf, n);
}

// GET /api/console?since=<seq> -> neue Konsolenzeilen
static esp_err_t h_console(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;

    uint64_t since = 0;
    char qbuf[64];
    if (httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf)) == ESP_OK) {
        char val[32];
        if (httpd_query_key_value(qbuf, "since", val, sizeof(val)) == ESP_OK) {
            since = strtoull(val, NULL, 10);
        }
    }
    static char out[6144];
    uint64_t last = since;
    int n = console_log_dump_since(since, out, sizeof(out), &last);
    if (n < 0) { httpd_resp_send_500(req); return ESP_FAIL; }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, out, n);
}

// GET /api/events?since=<seq> -> strukturierte Debug-Events (Basic-Auth)
static esp_err_t h_events(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;

    uint64_t since = 0;
    char qbuf[64];
    if (httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf)) == ESP_OK) {
        char val[32];
        if (httpd_query_key_value(qbuf, "since", val, sizeof(val)) == ESP_OK) {
            since = strtoull(val, NULL, 10);
        }
    }
    static char out[8192];
    uint64_t last = since;
    int n = event_log_dump_since(since, out, sizeof(out), &last);
    if (n < 0) { httpd_resp_send_500(req); return ESP_FAIL; }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, out, n);
}

// -----------------------------------------------------------------------------
// TCM515 Base-ID lesen/schreiben (ESP3 Common Commands CO_RD_IDBASE 0x08 /
// CO_WR_IDBASE 0x07). Basic-Auth wie die uebrigen Portal-Endpunkte.
// -----------------------------------------------------------------------------
// Base-ID aus dem TCM lesen. id_out[4], writes -> Rest-Schreibzyklen (-1 = n/a).
static esp_err_t baseid_read_raw(uint8_t id_out[4], int *writes_out)
{
    const uint8_t cmd = 0x08;               // CO_RD_IDBASE
    uint8_t resp[72];
    size_t rlen = 0;
    esp_err_t e = enocean_uart_command(&cmd, 1, resp, sizeof(resp), &rlen, 600);
    if (e != ESP_OK) return e;
    if (rlen < 7) return ESP_FAIL;
    uint16_t dlen = (uint16_t)((resp[1] << 8) | resp[2]);
    uint8_t  olen = resp[3];
    // data = [retcode, baseID(4)]; benoetigt 5 Byte + CRC + Header im Puffer.
    if (dlen < 5 || (size_t)(6 + dlen) > rlen) return ESP_FAIL;
    const uint8_t *data = &resp[6];
    if (data[0] != 0x00) return ESP_FAIL;   // RET_OK erwartet
    memcpy(id_out, &data[1], 4);
    if (writes_out) {
        // Optional Data[0] = verbleibende Schreibzyklen (falls vorhanden).
        *writes_out = (olen >= 1 && (size_t)(6 + dlen) < rlen) ? resp[6 + dlen] : -1;
    }
    return ESP_OK;
}

static esp_err_t baseid_send_json(httpd_req_t *req, const uint8_t id[4], int writes)
{
    char reply[96];
    if (writes >= 0) {
        snprintf(reply, sizeof(reply),
                 "{\"base_id\":\"%02X-%02X-%02X-%02X\",\"writes_remaining\":%d}",
                 id[0], id[1], id[2], id[3], writes);
    } else {
        snprintf(reply, sizeof(reply),
                 "{\"base_id\":\"%02X-%02X-%02X-%02X\"}",
                 id[0], id[1], id[2], id[3]);
    }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, reply);
}

static esp_err_t baseid_err(httpd_req_t *req, const char *status, const char *msg)
{
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "application/json");
    char reply[128];
    snprintf(reply, sizeof(reply), "{\"error\":\"%s\"}", msg);
    return httpd_resp_sendstr(req, reply);
}

// GET /api/baseid -> aktuelle Base-ID
static esp_err_t h_baseid_read(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    uint8_t id[4];
    int writes = -1;
    if (baseid_read_raw(id, &writes) != ESP_OK) {
        return baseid_err(req, "504 Gateway Timeout", "TCM515 antwortet nicht");
    }
    return baseid_send_json(req, id, writes);
}

// POST /api/baseid  Body {"base_id":"FF-xx-xx-xx"} -> Base-ID schreiben
static esp_err_t h_baseid_write(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    if (!body_size_ok(req)) return ESP_OK;

    char *body = read_body(req);
    if (!body) { httpd_resp_send_500(req); return ESP_FAIL; }
    cJSON *j = cJSON_Parse(body);
    free(body);
    if (!j) return baseid_err(req, "400 Bad Request", "bad json");

    const cJSON *bid = cJSON_GetObjectItem(j, "base_id");
    uint8_t id[4];
    size_t n = 0;
    if (bid && cJSON_IsString(bid) && bid->valuestring) {
        n = parse_hex_str(bid->valuestring, id, sizeof(id));
    }
    cJSON_Delete(j);
    if (n != 4) return baseid_err(req, "400 Bad Request", "base_id Format FF-xx-xx-xx");

    // Gueltiger Bereich laut TCM-Datenblatt: FF800000 .. FFFFFF80.
    uint32_t v = ((uint32_t)id[0] << 24) | ((uint32_t)id[1] << 16) |
                 ((uint32_t)id[2] << 8) | id[3];
    if (v < 0xFF800000u || v > 0xFFFFFF80u) {
        return baseid_err(req, "400 Bad Request", "Base-ID außerhalb FF800000..FFFFFF80");
    }

    uint8_t cmd[5] = { 0x07, id[0], id[1], id[2], id[3] };   // CO_WR_IDBASE
    uint8_t resp[72];
    size_t rlen = 0;
    esp_err_t e = enocean_uart_command(cmd, sizeof(cmd), resp, sizeof(resp), &rlen, 600);
    if (e != ESP_OK || rlen < 7) {
        return baseid_err(req, "504 Gateway Timeout", "TCM515 antwortet nicht");
    }
    // data[0] = retcode: 0x00 OK, 0x02 NOT_SUPPORTED, 0x05 baseID range/zaehler.
    if (resp[6] != 0x00) {
        return baseid_err(req, "409 Conflict",
                          "Schreiben abgelehnt (Zyklen aufgebraucht oder ungültig)");
    }
    sec_event("baseid_write", "neue Base-ID %02X%02X%02X%02X", id[0], id[1], id[2], id[3]);
    EVT_WARN("enocean", "Base-ID geschrieben: %02X-%02X-%02X-%02X", id[0], id[1], id[2], id[3]);

    // Zur Bestaetigung zurueklesen (liefert auch die Rest-Schreibzyklen).
    uint8_t rd[4];
    int writes = -1;
    if (baseid_read_raw(rd, &writes) == ESP_OK) {
        return baseid_send_json(req, rd, writes);
    }
    return baseid_send_json(req, id, -1);
}

// -----------------------------------------------------------------------------
// REST-API (eigener Reiter): Token-Auth ueber den Geraete-Token (tcp_token),
// per "Authorization: Bearer <token>" ODER "?token=<token>". Nur aktiv wenn
// api_enabled gesetzt ist. Bewusst KEINE Basic-Auth - fuer externe Consumer.
// -----------------------------------------------------------------------------
static size_t parse_hex_str(const char *s, uint8_t *out, size_t outcap)
{
    size_t n = 0;
    int hi = -1;
    for (const char *p = s; *p && n < outcap; p++) {
        int v;
        char c = *p;
        if      (c >= '0' && c <= '9') v = c - '0';
        else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
        else continue;
        if (hi < 0) hi = v;
        else { out[n++] = (uint8_t)((hi << 4) | v); hi = -1; }
    }
    return n;
}

// Token aus "Authorization: Bearer <t>" oder "?token=<t>" extrahieren.
static void get_req_token(httpd_req_t *req, char *out, size_t out_size)
{
    out[0] = '\0';
    char auth[128];
    if (httpd_req_get_hdr_value_str(req, "Authorization", auth, sizeof(auth)) == ESP_OK &&
        strncmp(auth, "Bearer ", 7) == 0) {
        // Bewusst gekappt kopieren: ein Token laenger als out_size-1 kann
        // ohnehin nicht matchen.
        const char *tok = auth + 7;
        size_t k = 0;
        while (tok[k] && k + 1 < out_size) { out[k] = tok[k]; k++; }
        out[k] = '\0';
    }
    if (!out[0]) {
        char q[192];
        if (httpd_req_get_url_query_str(req, q, sizeof(q)) == ESP_OK) {
            httpd_query_key_value(q, "token", out, out_size);
        }
    }
}

static bool api_authorized(httpd_req_t *req, const eul_config_t *cfg)
{
    if (!cfg->api_enabled) return false;
    char provided[EUL_TCP_TOKEN_MAX] = {0};
    get_req_token(req, provided, sizeof(provided));
    if (!provided[0]) return false;
    return sec_constant_time_equal(provided, cfg->tcp_token);
}

// OTA-Token-Check: eigener Token NUR fuer /api/ota, damit Update-Rechte
// delegierbar sind ohne das Admin-Passwort weiterzugeben. Unabhaengig von
// api_enabled (das schaltet nur die Telegramm-REST-API).
static bool ota_token_ok(httpd_req_t *req, const eul_config_t *cfg)
{
    if (!cfg->ota_token[0]) return false;
    char provided[EUL_TCP_TOKEN_MAX] = {0};
    get_req_token(req, provided, sizeof(provided));
    if (!provided[0]) return false;
    return sec_constant_time_equal(provided, cfg->ota_token);
}

static esp_err_t api_reject(httpd_req_t *req)
{
    httpd_resp_set_status(req, "401 Unauthorized");
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, "{\"error\":\"api disabled or invalid token\"}");
}

// GET /api/telegrams -> letzte empfangene Telegramme als JSON-Array
static esp_err_t h_telegrams(httpd_req_t *req)
{
    eul_config_t cfg;
    if (config_load(&cfg) != ESP_OK) { httpd_resp_send_500(req); return ESP_FAIL; }
    if (!api_authorized(req, &cfg)) return api_reject(req);

    static char out[8192];
    int n = telemetry_dump_json(out, sizeof(out));
    if (n < 0) { httpd_resp_send_500(req); return ESP_FAIL; }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, out, n);
}

// POST /api/send  Body {"hex":"55...."} -> ESP3-Frame an den TCM515
static esp_err_t h_send(httpd_req_t *req)
{
    eul_config_t cfg;
    if (config_load(&cfg) != ESP_OK) { httpd_resp_send_500(req); return ESP_FAIL; }
    if (!api_authorized(req, &cfg)) return api_reject(req);

    if (!body_size_ok(req)) return ESP_OK;
    char *body = read_body(req);
    if (!body) { httpd_resp_send_500(req); return ESP_FAIL; }
    cJSON *j = cJSON_Parse(body);
    free(body);
    if (!j) { httpd_resp_set_status(req, "400 Bad Request"); return httpd_resp_sendstr(req, "{\"error\":\"bad json\"}"); }

    const cJSON *hex = cJSON_GetObjectItem(j, "hex");
    uint8_t frame[64];
    size_t nf = 0;
    if (hex && cJSON_IsString(hex) && hex->valuestring) {
        nf = parse_hex_str(hex->valuestring, frame, sizeof(frame));
    }
    cJSON_Delete(j);

    if (nf < 6) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_sendstr(req, "{\"error\":\"hex missing or too short\"}");
    }
    esp_err_t w = enocean_uart_write_frame(frame, nf);
    // In die Web-Konsole spiegeln, damit ueber die REST-API gesendete Frames
    // dort genauso sichtbar sind wie die der TCP-Clients - sonst fehlt beim
    // Debuggen ausgerechnet die eigene Sende-Richtung.
    if (w == ESP_OK) console_log_frame_from("REST-API", frame, nf);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, w == ESP_OK ? "{\"ok\":true}" : "{\"ok\":false}");
}

// POST /api/ota  Body = rohes Firmware-.bin -> in die inaktive OTA-Partition
// schreiben, als Boot-Partition setzen, neu starten.
// Auth: OTA-Token (Bearer/Query) ODER Basic-Auth.
static esp_err_t h_ota(httpd_req_t *req)
{
    eul_config_t cfg;
    if (config_load(&cfg) != ESP_OK) { httpd_resp_send_500(req); return ESP_FAIL; }
    if (ota_token_ok(req, &cfg)) {
        sec_event("ota_token_auth", "update via ota token");
    } else {
        // Wurde ein Token MITGESCHICKT, war er aber falsch: klare JSON-Antwort
        // statt einer Basic-Auth-Aufforderung - der Aufrufer ist offensichtlich
        // ein API-Client und kein Browser.
        char tok[EUL_TCP_TOKEN_MAX] = {0};
        get_req_token(req, tok, sizeof(tok));
        if (tok[0]) {
            sec_event("ota_token_fail", "falscher OTA-Token");
            return api_reject(req);
        }
        if (!check_basic_auth(req, &cfg)) return ESP_OK;   // 401 bereits gesendet
    }

    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (!part) { httpd_resp_send_500(req); return ESP_FAIL; }

    esp_ota_handle_t ota = 0;
    if (esp_ota_begin(part, OTA_WITH_SEQUENTIAL_WRITES, &ota) != ESP_OK) {
        httpd_resp_send_500(req); return ESP_FAIL;
    }

    char *buf = malloc(4096);
    if (!buf) { esp_ota_abort(ota); httpd_resp_send_500(req); return ESP_FAIL; }

    int remaining = (int)req->content_len;
    bool ok = true;
    // Ein Client, der Content-Length ankuendigt aber nichts sendet, wuerde die
    // (einzige) HTTP-Server-Task sonst ENDLOS blockieren - das Portal waere bis
    // zum Power-Cycle tot. Darum: Leerlauf-Timeouts zaehlen und nach 60 s ohne
    // ein einziges Byte abbrechen.
    const int MAX_IDLE = 12;                  // 12 x recv_wait_timeout (5 s)
    int idle = 0;
    while (remaining > 0) {
        int r = httpd_req_recv(req, buf, remaining < 4096 ? remaining : 4096);
        if (r == HTTPD_SOCK_ERR_TIMEOUT) {    // langsamer Upload -> begrenzt warten
            if (++idle >= MAX_IDLE) { ok = false; break; }
            continue;
        }
        if (r <= 0) { ok = false; break; }
        idle = 0;                              // Fortschritt -> Zaehler zuruecksetzen
        if (esp_ota_write(ota, buf, r) != ESP_OK) { ok = false; break; }
        remaining -= r;
    }
    free(buf);

    if (!ok) {
        esp_ota_abort(ota);
        sec_event("ota_fail", "upload abgebrochen (%d B offen)", remaining);
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"upload\"}");
    }
    if (esp_ota_end(ota) != ESP_OK) {
        sec_event("ota_fail", "Image ungültig");
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"ungültiges Image\"}");
    }
    if (esp_ota_set_boot_partition(part) != ESP_OK) {
        httpd_resp_send_500(req); return ESP_FAIL;
    }
    sec_event("ota_ok", "update -> %s, reboot", part->label);
    EVT_WARN("ota", "Update erfolgreich (%s) - Neustart", part->label);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":true}");
    schedule_reboot();
    return ESP_OK;
}

esp_err_t http_portal_start(bool ap_mode)
{
    s_ap_mode = ap_mode;

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    // Achtung: muss ALLE registrierten Handler decken - im AP-Modus kommen zu
    // den API-Handlern noch 4 Captive-Portal-Redirects dazu. Mit 16 schlugen
    // deren Registrierungen frueher still fehl.
    cfg.max_uri_handlers = 24;
    cfg.stack_size = 8192;
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    // Mehr gleichzeitige Verbindungen zulassen und alte automatisch schliessen
    // wenn wir am Limit sind. Sonst haengen Verbindungen im TIME_WAIT und der
    // naechste Client bekommt RST beim Accept.
    cfg.max_open_sockets = 10;
    cfg.lru_purge_enable = true;
    cfg.keep_alive_enable = true;
    cfg.keep_alive_idle     = 5;
    cfg.keep_alive_interval = 5;
    cfg.keep_alive_count    = 3;
    cfg.recv_wait_timeout = 5;
    cfg.send_wait_timeout = 5;

    httpd_handle_t srv = NULL;
    esp_err_t r = httpd_start(&srv, &cfg);
    if (r != ESP_OK) return r;

    httpd_uri_t u_root = { .uri="/",        .method=HTTP_GET,  .handler=h_root };
    httpd_uri_t u_st   = { .uri="/api/state", .method=HTTP_GET,  .handler=h_state };
    httpd_uri_t u_sc   = { .uri="/api/scan",  .method=HTTP_GET,  .handler=h_scan  };
    httpd_uri_t u_cf   = { .uri="/api/config", .method=HTTP_POST, .handler=h_config };
    httpd_uri_t u_rt   = { .uri="/api/regen-token", .method=HTTP_POST, .handler=h_regen_token };
    httpd_uri_t u_rot  = { .uri="/api/regen-ota-token", .method=HTTP_POST, .handler=h_regen_ota_token };
    httpd_uri_t u_fr   = { .uri="/api/factory-reset", .method=HTTP_POST, .handler=h_factory };
    httpd_uri_t u_rb   = { .uri="/api/reboot", .method=HTTP_POST, .handler=h_reboot };
    httpd_uri_t u_cl   = { .uri="/api/clients", .method=HTTP_GET, .handler=h_clients };
    httpd_uri_t u_ss   = { .uri="/api/stats",   .method=HTTP_GET, .handler=h_stats };
    httpd_uri_t u_co   = { .uri="/api/console", .method=HTTP_GET, .handler=h_console };
    httpd_uri_t u_tel  = { .uri="/api/telegrams", .method=HTTP_GET,  .handler=h_telegrams };
    httpd_uri_t u_snd  = { .uri="/api/send",      .method=HTTP_POST, .handler=h_send };
    httpd_uri_t u_ev   = { .uri="/api/events",    .method=HTTP_GET,  .handler=h_events };
    httpd_uri_t u_ota  = { .uri="/api/ota",       .method=HTTP_POST, .handler=h_ota };
    httpd_uri_t u_bidr = { .uri="/api/baseid",    .method=HTTP_GET,  .handler=h_baseid_read };
    httpd_uri_t u_bidw = { .uri="/api/baseid",    .method=HTTP_POST, .handler=h_baseid_write };
    // Captive-Portal-Erkennung bekannter Betriebssysteme: alles auf / umleiten
    httpd_uri_t u_gen  = { .uri="/generate_204", .method=HTTP_GET, .handler=h_captive };
    httpd_uri_t u_hs   = { .uri="/hotspot-detect.html", .method=HTTP_GET, .handler=h_captive };
    httpd_uri_t u_ncsi = { .uri="/ncsi.txt", .method=HTTP_GET, .handler=h_captive };
    httpd_uri_t u_all  = { .uri="/*", .method=HTTP_GET, .handler=h_captive };

    httpd_register_uri_handler(srv, &u_root);
    httpd_register_uri_handler(srv, &u_st);
    httpd_register_uri_handler(srv, &u_sc);
    httpd_register_uri_handler(srv, &u_cf);
    httpd_register_uri_handler(srv, &u_rt);
    httpd_register_uri_handler(srv, &u_rot);
    httpd_register_uri_handler(srv, &u_fr);
    httpd_register_uri_handler(srv, &u_rb);
    httpd_register_uri_handler(srv, &u_cl);
    httpd_register_uri_handler(srv, &u_ss);
    httpd_register_uri_handler(srv, &u_co);
    httpd_register_uri_handler(srv, &u_tel);
    httpd_register_uri_handler(srv, &u_snd);
    httpd_register_uri_handler(srv, &u_ev);
    httpd_register_uri_handler(srv, &u_ota);
    httpd_register_uri_handler(srv, &u_bidr);
    httpd_register_uri_handler(srv, &u_bidw);
    if (ap_mode) {
        httpd_register_uri_handler(srv, &u_gen);
        httpd_register_uri_handler(srv, &u_hs);
        httpd_register_uri_handler(srv, &u_ncsi);
        httpd_register_uri_handler(srv, &u_all);
    }

    ESP_LOGI(TAG, "portal started (%s)", ap_mode ? "AP/no-auth" : "STA/basic-auth");
    return ESP_OK;
}
