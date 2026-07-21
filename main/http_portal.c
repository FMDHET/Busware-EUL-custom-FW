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
#include "wifi_sta.h"

#include "mbedtls/base64.h"
#include "cJSON.h"

static const char *TAG = "eul-http";
static bool s_ap_mode = false;

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
    httpd_resp_set_hdr(req, "WWW-Authenticate", "Basic realm=\"EUL22\"");
    httpd_resp_sendstr(req, "auth required");
    return false;
}

static bool require_auth(httpd_req_t *req)
{
    eul_config_t cfg;
    if (config_load(&cfg) != ESP_OK) return false;
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
    cJSON_AddBoolToObject(root, "usb_enabled",       cfg.usb_enabled);
    cJSON_AddBoolToObject(root, "tcp_enabled",       cfg.tcp_enabled);
    cJSON_AddNumberToObject(root, "tcp_port",        cfg.tcp_port);
    cJSON_AddBoolToObject(root, "tcp_auth_required", cfg.tcp_auth_required);
    cJSON_AddStringToObject(root, "tcp_token",       cfg.tcp_token);
    cJSON_AddBoolToObject(root, "api_enabled",   cfg.api_enabled);
    cJSON_AddBoolToObject(root, "mqtt_enabled",  cfg.mqtt_enabled);
    cJSON_AddStringToObject(root, "mqtt_host",   cfg.mqtt_host);
    cJSON_AddNumberToObject(root, "mqtt_port",   cfg.mqtt_port);
    cJSON_AddStringToObject(root, "mqtt_user",   cfg.mqtt_user);
    cJSON_AddStringToObject(root, "mqtt_topic",  cfg.mqtt_topic);
    cJSON_AddBoolToObject(root, "mqtt_discovery",    cfg.mqtt_discovery);
    cJSON_AddBoolToObject(root, "mqtt_retain",       cfg.mqtt_retain);
    cJSON_AddStringToObject(root, "mqtt_disc_prefix", cfg.mqtt_disc_prefix);
    cJSON_AddStringToObject(root, "device_name", cfg.device_name);
    cJSON_AddStringToObject(root, "admin_user",  cfg.admin_user);
    cJSON_AddStringToObject(root, "ntp_server",  cfg.ntp_server);
    // WLAN-/MQTT-Passwort nur im STA-Modus ausliefern (dort schuetzt Basic-Auth
    // das Portal), damit der Nutzer sein gespeichertes Passwort ansehen kann.
    // Im offenen AP-Modus (Erst-Setup) niemals Secrets herausgeben.
    cJSON_AddStringToObject(root, "wifi_pass", s_ap_mode ? "" : cfg.wifi_pass);
    cJSON_AddStringToObject(root, "mqtt_pass", s_ap_mode ? "" : cfg.mqtt_pass);
    // Admin-Pass nur im AP-Modus einmalig anzeigen. Im STA nur Platzhalter.
    cJSON_AddStringToObject(root, "admin_pass",
                            s_ap_mode ? cfg.admin_pass : "");

    char *out = cJSON_PrintUnformatted(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, out);
    free(out);
    cJSON_Delete(root);
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
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, out);
    free(out);
    cJSON_Delete(arr);
    return ESP_OK;
}

static char *read_body(httpd_req_t *req)
{
    size_t total = req->content_len;
    if (total == 0 || total > 4096) return NULL;
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
    esp_err_t rg = config_save_general(
        (dev_name && cJSON_IsString(dev_name)) ? dev_name->valuestring : cur.device_name,
        (adm_user && cJSON_IsString(adm_user) && adm_user->valuestring[0]) ? adm_user->valuestring : cur.admin_user,
        (ntp_srv  && cJSON_IsString(ntp_srv)  && ntp_srv->valuestring[0])  ? ntp_srv->valuestring  : cur.ntp_server);

    // Neues Portal-Passwort nur wenn geliefert (>=8 Zeichen), sonst unveraendert.
    const cJSON *adm_pass = cJSON_GetObjectItem(j, "admin_pass");
    if (adm_pass && cJSON_IsString(adm_pass) && adm_pass->valuestring && strlen(adm_pass->valuestring) >= 8) {
        (void)config_set_admin_pass(adm_pass->valuestring);
    }

    // REST-API + MQTT. mqtt_pass leer => bisheriges Passwort behalten.
    const cJSON *api_en   = cJSON_GetObjectItem(j, "api_enabled");
    const cJSON *mq_en    = cJSON_GetObjectItem(j, "mqtt_enabled");
    const cJSON *mq_host  = cJSON_GetObjectItem(j, "mqtt_host");
    const cJSON *mq_port  = cJSON_GetObjectItem(j, "mqtt_port");
    const cJSON *mq_user  = cJSON_GetObjectItem(j, "mqtt_user");
    const cJSON *mq_pass  = cJSON_GetObjectItem(j, "mqtt_pass");
    const cJSON *mq_topic = cJSON_GetObjectItem(j, "mqtt_topic");
    const cJSON *mq_disc  = cJSON_GetObjectItem(j, "mqtt_discovery");
    const cJSON *mq_ret   = cJSON_GetObjectItem(j, "mqtt_retain");
    const cJSON *mq_pref  = cJSON_GetObjectItem(j, "mqtt_disc_prefix");
    bool mp_set = mq_pass && cJSON_IsString(mq_pass) && mq_pass->valuestring && mq_pass->valuestring[0];

    esp_err_t ri = config_save_integrations(
        (api_en   && cJSON_IsBool(api_en))     ? cJSON_IsTrue(api_en) : cur.api_enabled,
        (mq_en    && cJSON_IsBool(mq_en))      ? cJSON_IsTrue(mq_en)  : cur.mqtt_enabled,
        (mq_host  && cJSON_IsString(mq_host))  ? mq_host->valuestring : cur.mqtt_host,
        (mq_port  && cJSON_IsNumber(mq_port))  ? (uint16_t)mq_port->valueint : cur.mqtt_port,
        (mq_user  && cJSON_IsString(mq_user))  ? mq_user->valuestring : cur.mqtt_user,
        mp_set                                 ? mq_pass->valuestring : cur.mqtt_pass,
        (mq_topic && cJSON_IsString(mq_topic)) ? mq_topic->valuestring : cur.mqtt_topic,
        (mq_disc  && cJSON_IsBool(mq_disc))    ? cJSON_IsTrue(mq_disc) : cur.mqtt_discovery,
        (mq_ret   && cJSON_IsBool(mq_ret))     ? cJSON_IsTrue(mq_ret)  : cur.mqtt_retain,
        (mq_pref  && cJSON_IsString(mq_pref))  ? mq_pref->valuestring  : cur.mqtt_disc_prefix);

    cJSON_Delete(j);

    if (rm != ESP_OK || ri != ESP_OK || rg != ESP_OK) { httpd_resp_send_500(req); return ESP_FAIL; }
    sec_event("config_change", "applied via portal");
    httpd_resp_sendstr(req, "{\"ok\":true}");
    schedule_reboot();
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
    char reply[128];
    snprintf(reply, sizeof(reply), "{\"token\":\"%s\"}", tok);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, reply);
}

static esp_err_t h_factory(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    config_factory_reset();
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

    char buf[384];
    int n = snprintf(buf, sizeof(buf),
        "{\"clients\":%d,"
        "\"tcm_rx_bytes\":%llu,\"tcm_tx_bytes\":%llu,"
        "\"tcm_rx_frames\":%u,\"tcm_tx_frames\":%u,"
        "\"ip\":\"%s\",\"rssi\":%d,\"uptime_ms\":%llu,\"epoch_ms\":%lld}",
        tcp_server_active_clients(),
        (unsigned long long)enocean_uart_rx_bytes(),
        (unsigned long long)enocean_uart_tx_bytes(),
        (unsigned)enocean_uart_rx_frames(),
        (unsigned)enocean_uart_tx_frames(),
        ip ? ip : "",
        rssi,
        (unsigned long long)(esp_timer_get_time() / 1000),
        epoch_ms);
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

static bool api_authorized(httpd_req_t *req, const eul_config_t *cfg)
{
    if (!cfg->api_enabled) return false;
    char provided[EUL_TCP_TOKEN_MAX] = {0};

    char auth[128];
    if (httpd_req_get_hdr_value_str(req, "Authorization", auth, sizeof(auth)) == ESP_OK &&
        strncmp(auth, "Bearer ", 7) == 0) {
        const char *tok = auth + 7;
        size_t k = 0;
        while (tok[k] && k < sizeof(provided) - 1) { provided[k] = tok[k]; k++; }
        provided[k] = '\0';
    }
    if (!provided[0]) {
        char q[192];
        if (httpd_req_get_url_query_str(req, q, sizeof(q)) == ESP_OK) {
            httpd_query_key_value(q, "token", provided, sizeof(provided));
        }
    }
    if (!provided[0]) return false;
    return sec_constant_time_equal(provided, cfg->tcp_token);
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
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, w == ESP_OK ? "{\"ok\":true}" : "{\"ok\":false}");
}

esp_err_t http_portal_start(bool ap_mode)
{
    s_ap_mode = ap_mode;

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.max_uri_handlers = 16;
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
    httpd_uri_t u_fr   = { .uri="/api/factory-reset", .method=HTTP_POST, .handler=h_factory };
    httpd_uri_t u_rb   = { .uri="/api/reboot", .method=HTTP_POST, .handler=h_reboot };
    httpd_uri_t u_cl   = { .uri="/api/clients", .method=HTTP_GET, .handler=h_clients };
    httpd_uri_t u_ss   = { .uri="/api/stats",   .method=HTTP_GET, .handler=h_stats };
    httpd_uri_t u_co   = { .uri="/api/console", .method=HTTP_GET, .handler=h_console };
    httpd_uri_t u_tel  = { .uri="/api/telegrams", .method=HTTP_GET,  .handler=h_telegrams };
    httpd_uri_t u_snd  = { .uri="/api/send",      .method=HTTP_POST, .handler=h_send };
    httpd_uri_t u_ev   = { .uri="/api/events",    .method=HTTP_GET,  .handler=h_events };
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
    httpd_register_uri_handler(srv, &u_fr);
    httpd_register_uri_handler(srv, &u_rb);
    httpd_register_uri_handler(srv, &u_cl);
    httpd_register_uri_handler(srv, &u_ss);
    httpd_register_uri_handler(srv, &u_co);
    httpd_register_uri_handler(srv, &u_tel);
    httpd_register_uri_handler(srv, &u_snd);
    httpd_register_uri_handler(srv, &u_ev);
    if (ap_mode) {
        httpd_register_uri_handler(srv, &u_gen);
        httpd_register_uri_handler(srv, &u_hs);
        httpd_register_uri_handler(srv, &u_ncsi);
        httpd_register_uri_handler(srv, &u_all);
    }

    ESP_LOGI(TAG, "portal started (%s)", ap_mode ? "AP/no-auth" : "STA/basic-auth");
    return ESP_OK;
}
