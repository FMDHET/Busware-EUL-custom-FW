// EUL22 Konfigurations-Portal (Frontend).
//
// Wird via esbuild in ein einzelnes IIFE gebundelt, in index.html
// eingebettet und dann als C-String in main/portal_html.h abgelegt.

// -----------------------------------------------------------------------------
// Types (spiegeln HTTP-Backend)
// -----------------------------------------------------------------------------
type Mode = 'provisioning' | 'normal';

interface State {
    mode: Mode;
    suffix: string;
    wifi_ssid: string;
    usb_enabled: boolean;
    tcp_enabled: boolean;
    tcp_port: number;
    tcp_auth_required: boolean;
    tcp_token: string;
    admin_pass: string;
    api_enabled: boolean;
    mqtt_enabled: boolean;
    mqtt_host: string;
    mqtt_port: number;
    mqtt_user: string;
    mqtt_topic: string;
    mqtt_discovery: boolean;
    mqtt_retain: boolean;
    mqtt_disc_prefix: string;
    device_name: string;
    admin_user: string;
    ntp_server: string;
}

interface Network {
    ssid: string;
    rssi: number;
    auth: string;
}

interface Client {
    peer: string;
    connected_ms: number;
    rx_bytes: number;
    tx_bytes: number;
    rx_frames: number;
}

interface Stats {
    clients: number;
    tcm_rx_bytes: number;
    tcm_tx_bytes: number;
    tcm_rx_frames: number;
    tcm_tx_frames: number;
    ip: string;
    rssi: number;
    uptime_ms: number;
    epoch_ms: number;
}

interface ConsoleLine {
    seq: number;
    ms: number;
    line: string;
}

interface ConsoleResp {
    lines: ConsoleLine[];
    last_seq: number;
}

interface SaveBody {
    tcp_enabled: boolean;
    tcp_port: number;
    tcp_auth_required: boolean;
    usb_enabled: boolean;
    api_enabled: boolean;
    mqtt_enabled: boolean;
    mqtt_host: string;
    mqtt_port: number;
    mqtt_user: string;
    mqtt_topic: string;
    mqtt_discovery: boolean;
    mqtt_retain: boolean;
    mqtt_disc_prefix: string;
    device_name: string;
    admin_user: string;
    ntp_server: string;
    mqtt_pass?: string;
    admin_pass?: string;
    wifi_ssid?: string;
    wifi_pass?: string;
}

// -----------------------------------------------------------------------------
// Icons
// -----------------------------------------------------------------------------
const EYE_OPEN =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';

const EYE_CLOSED =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.4 19.4 0 0 1 5.06-5.94"/>' +
    '<path d="M9.9 4.24A11 11 0 0 1 12 4c7 0 11 8 11 8a19.3 19.3 0 0 1-2.16 3.19"/>' +
    '<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// -----------------------------------------------------------------------------
// DOM Helpers
// -----------------------------------------------------------------------------
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el as T;
}

function say(text: string): void {
    byId('status').textContent = text;
}

function currentHost(): string {
    return window.location.hostname;
}

// -----------------------------------------------------------------------------
// Tabs
// -----------------------------------------------------------------------------
type TabName = 'status' | 'allgemein' | 'wifi' | 'usb' | 'enocean' | 'api' | 'mqtt' | 'konsole';

function activateTab(name: TabName): void {
    document.querySelectorAll<HTMLButtonElement>('nav.tabs button').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll<HTMLElement>('.tab').forEach((s) => {
        s.classList.toggle('active', s.id === `tab-${name}`);
    });
    if (location.hash !== `#${name}`) {
        history.replaceState(null, '', `#${name}`);
    }
}

function activeTabName(): string {
    const el = document.querySelector<HTMLButtonElement>('nav.tabs button.active');
    return el?.dataset.tab ?? '';
}

function initTabs(): void {
    document.querySelectorAll<HTMLButtonElement>('nav.tabs button').forEach((btn) => {
        btn.addEventListener('click', () => activateTab(btn.dataset.tab as TabName));
    });
    const initial = location.hash.replace('#', '') as TabName;
    if (initial && document.getElementById(`tab-${initial}`)) {
        activateTab(initial);
    }
    window.addEventListener('hashchange', () => {
        const n = location.hash.replace('#', '') as TabName;
        if (n && document.getElementById(`tab-${n}`)) activateTab(n);
    });
}

// -----------------------------------------------------------------------------
// Passwort-Inputs mit Auge-Toggle
// -----------------------------------------------------------------------------
function wireEyeToggles(): void {
    document.querySelectorAll<HTMLInputElement>('input[data-eye]').forEach((input) => {
        const wrap = document.createElement('div');
        wrap.className = 'pw-wrap';
        input.parentNode!.insertBefore(wrap, input);
        wrap.appendChild(input);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pw-eye';
        btn.setAttribute('aria-label', 'Passwort anzeigen');
        btn.innerHTML = EYE_CLOSED;
        wrap.appendChild(btn);

        btn.addEventListener('click', () => {
            const showing = input.type === 'password';
            input.type = showing ? 'text' : 'password';
            btn.innerHTML = showing ? EYE_OPEN : EYE_CLOSED;
            btn.setAttribute('aria-label', showing ? 'Passwort verbergen' : 'Passwort anzeigen');
        });
    });
}

// -----------------------------------------------------------------------------
// Secret-Anzeige (readonly, per Klick sichtbar/verborgen)
// -----------------------------------------------------------------------------
class SecretDisplay {
    private valueEl: HTMLElement;
    private btn: HTMLButtonElement;
    private value = '';
    private revealed = false;

    constructor(private host: HTMLElement) {
        this.host.innerHTML =
            '<span class="val"></span>' +
            '<button type="button" class="pw-eye" aria-label="anzeigen"></button>';
        this.valueEl = this.host.querySelector<HTMLElement>('.val')!;
        this.btn = this.host.querySelector<HTMLButtonElement>('.pw-eye')!;
        this.btn.addEventListener('click', () => {
            this.revealed = !this.revealed;
            this.render();
        });
        this.render();
    }

    set(v: string): void {
        this.value = v;
        this.render();
    }

    private render(): void {
        if (!this.value) {
            this.valueEl.textContent = '—';
        } else if (this.revealed) {
            this.valueEl.textContent = this.value;
        } else {
            // Konstante Punkt-Anzahl damit die Zeichenzahl nicht leakt
            this.valueEl.textContent = '••••••••••••';
        }
        this.btn.innerHTML = this.revealed ? EYE_OPEN : EYE_CLOSED;
        this.btn.setAttribute('aria-label', this.revealed ? 'verbergen' : 'anzeigen');
    }
}

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------
async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
    const r = await fetch(url, init);
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
}

const api = {
    state: (): Promise<State> => apiJson('/api/state'),
    scan: (): Promise<Network[]> => apiJson('/api/scan'),
    clients: (): Promise<Client[]> => apiJson('/api/clients'),
    stats: (): Promise<Stats> => apiJson('/api/stats'),
    console: (since: number): Promise<ConsoleResp> => apiJson(`/api/console?since=${since}`),
    save: (body: SaveBody): Promise<{ ok: boolean }> =>
        apiJson('/api/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
    regenToken: (): Promise<{ token: string }> => apiJson('/api/regen-token', { method: 'POST' }),
    factoryReset: (): Promise<{ ok: boolean }> => apiJson('/api/factory-reset', { method: 'POST' }),
};

// -----------------------------------------------------------------------------
// Formatierung
// -----------------------------------------------------------------------------
function fmtBytes(n: number): string {
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return c;
        }
    });
}

// -----------------------------------------------------------------------------
// Form Handling
// -----------------------------------------------------------------------------
let tokenDisplay: SecretDisplay;
let adminDisplay: SecretDisplay;
let apiTokenDisplay: SecretDisplay;

async function loadState(): Promise<void> {
    try {
        const s = await api.state();
        byId<HTMLInputElement>('ssid').value = s.wifi_ssid || '';
        byId<HTMLInputElement>('tcp_en').checked = s.tcp_enabled;
        byId<HTMLInputElement>('tcp_port').value = String(s.tcp_port);
        byId<HTMLInputElement>('tcp_auth').checked = s.tcp_auth_required;
        byId<HTMLInputElement>('usb_en').checked = s.usb_enabled;
        tokenDisplay.set(s.tcp_token);
        adminDisplay.set(s.admin_pass);
        byId<HTMLInputElement>('api_en').checked = s.api_enabled;
        byId<HTMLInputElement>('mqtt_en').checked = s.mqtt_enabled;
        byId<HTMLInputElement>('mqtt_host').value = s.mqtt_host || '';
        byId<HTMLInputElement>('mqtt_port').value = String(s.mqtt_port || 1883);
        byId<HTMLInputElement>('mqtt_user').value = s.mqtt_user || '';
        byId<HTMLInputElement>('mqtt_topic').value = s.mqtt_topic || '';
        apiTokenDisplay.set(s.tcp_token);
        byId<HTMLInputElement>('dev_name').value = s.device_name || '';
        byId<HTMLInputElement>('admin_user').value = s.admin_user || 'admin';
        byId<HTMLInputElement>('ntp_server').value = s.ntp_server || 'pool.ntp.org';
        byId<HTMLInputElement>('mqtt_disc').checked = s.mqtt_discovery;
        byId<HTMLInputElement>('mqtt_ret').checked = s.mqtt_retain;
        byId<HTMLInputElement>('mqtt_prefix').value = s.mqtt_disc_prefix || 'homeassistant';
        const h1 = document.querySelector('header h1');
        if (h1 && s.device_name) h1.textContent = s.device_name;
        renderApiDoc(s.tcp_token, s.api_enabled);
        renderMqttDoc(s.mqtt_topic, s.suffix);
        if (!s.tcp_auth_required && s.tcp_enabled) renderHAYaml();
        say(`Modus: ${s.mode} · MAC-Suffix ${s.suffix}`);
    } catch (e) {
        say(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function doScan(): Promise<void> {
    say('scanne WLAN...');
    try {
        const arr = await api.scan();
        const sel = byId<HTMLSelectElement>('ssid_sel');
        sel.innerHTML = '<option value="">-- Netzwerk waehlen --</option>';
        arr.forEach((n) => {
            const opt = document.createElement('option');
            opt.value = n.ssid;
            opt.textContent = `${n.ssid} (${n.rssi} dBm${n.auth ? ', ' + n.auth : ''})`;
            sel.appendChild(opt);
        });
        sel.onchange = () => {
            byId<HTMLInputElement>('ssid').value = sel.value;
        };
        say(`${arr.length} Netze gefunden`);
    } catch (e) {
        say(`Scan-Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function doRegenToken(): Promise<void> {
    try {
        const r = await api.regenToken();
        tokenDisplay.set(r.token);
        apiTokenDisplay.set(r.token);
        renderApiDoc(r.token, byId<HTMLInputElement>('api_en').checked);
        say('neuer Token');
    } catch (e) {
        say(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function applyHAPreset(): void {
    byId<HTMLInputElement>('tcp_en').checked = true;
    byId<HTMLInputElement>('tcp_port').value = '5100';
    byId<HTMLInputElement>('tcp_auth').checked = false;
    renderHAYaml();
    say('HA-Eltako Preset gesetzt · nicht vergessen zu speichern');
}

function renderHAYaml(): void {
    const host = currentHost();
    const port = parseInt(byId<HTMLInputElement>('tcp_port').value, 10) || 5100;
    const yaml =
        'eltako:\n' +
        '  gateway:\n' +
        '    - id: 1\n' +
        '      device_type: eul_lan\n' +
        `      serial_path: ${host}\n` +
        `      port: ${port}\n` +
        '      base_id: FF-AA-00-00     # anpassen: base_id des TCM515\n';
    byId('ha_yaml').textContent = yaml;
    byId('ha_yaml_box').style.display = 'block';
}

function renderApiDoc(token: string, enabled: boolean): void {
    const host = currentHost();
    byId('api_doc').textContent =
        (enabled ? '' : '# API ist derzeit deaktiviert\n\n') +
        `GET  http://${host}/api/telegrams\n` +
        `     Header: Authorization: Bearer ${token}\n` +
        `     -> letzte empfangene Telegramme (JSON-Array)\n\n` +
        `POST http://${host}/api/send\n` +
        `     Header: Authorization: Bearer ${token}\n` +
        `     Body:   {"hex":"55...."}   (kompletter ESP3-Frame)\n\n` +
        `Beispiel:\n` +
        `curl -H "Authorization: Bearer ${token}" http://${host}/api/telegrams`;
}

function renderMqttDoc(topic: string, suffix: string): void {
    const base = topic || `eul22/${suffix}`;
    byId('mqtt_doc').textContent =
        `Empfangene Telegramme werden publiziert auf:\n  ${base}/rx\n\n` +
        `Sende-Kommandos abonniert das Geraet auf:\n  ${base}/send\n` +
        `  Payload = ESP3-Frame als Hex, z.B. "55 00 07 07 01 ..."`;
}

async function doSave(): Promise<void> {
    const body: SaveBody = {
        tcp_enabled: byId<HTMLInputElement>('tcp_en').checked,
        tcp_port: parseInt(byId<HTMLInputElement>('tcp_port').value, 10) || 5100,
        tcp_auth_required: byId<HTMLInputElement>('tcp_auth').checked,
        usb_enabled: byId<HTMLInputElement>('usb_en').checked,
        api_enabled: byId<HTMLInputElement>('api_en').checked,
        mqtt_enabled: byId<HTMLInputElement>('mqtt_en').checked,
        mqtt_host: byId<HTMLInputElement>('mqtt_host').value.trim(),
        mqtt_port: parseInt(byId<HTMLInputElement>('mqtt_port').value, 10) || 1883,
        mqtt_user: byId<HTMLInputElement>('mqtt_user').value.trim(),
        mqtt_topic: byId<HTMLInputElement>('mqtt_topic').value.trim(),
        mqtt_discovery: byId<HTMLInputElement>('mqtt_disc').checked,
        mqtt_retain: byId<HTMLInputElement>('mqtt_ret').checked,
        mqtt_disc_prefix: byId<HTMLInputElement>('mqtt_prefix').value.trim(),
        device_name: byId<HTMLInputElement>('dev_name').value.trim(),
        admin_user: byId<HTMLInputElement>('admin_user').value.trim(),
        ntp_server: byId<HTMLInputElement>('ntp_server').value.trim(),
    };
    const mqttPass = byId<HTMLInputElement>('mqtt_pass').value;
    if (mqttPass) body.mqtt_pass = mqttPass;
    const adminPass = byId<HTMLInputElement>('admin_pass_new').value;
    if (adminPass) {
        if (adminPass.length < 8) { say('Neues Portal-Passwort braucht min. 8 Zeichen'); return; }
        body.admin_pass = adminPass;
    }
    const s = byId<HTMLInputElement>('ssid').value.trim();
    const p = byId<HTMLInputElement>('pass').value;
    if (s && p) {
        body.wifi_ssid = s;
        body.wifi_pass = p;
    } else if (s || p) {
        if (!confirm('WLAN-Zugang bleibt unveraendert (nur SSID oder Passwort eingetragen). Fortfahren?')) return;
    }
    try {
        await api.save(body);
        say('gespeichert · Geraet startet neu...');
    } catch (e) {
        say(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function doFactoryReset(): Promise<void> {
    if (!confirm('Wirklich auf Werkseinstellungen zuruecksetzen? Alle Zugangsdaten werden neu erzeugt.')) return;
    try {
        await api.factoryReset();
        say('reset · neustart');
    } catch (e) {
        say(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// -----------------------------------------------------------------------------
// Live-Polls
// -----------------------------------------------------------------------------
async function pollClients(): Promise<void> {
    if (activeTabName() !== 'status') return;
    try {
        const arr = await api.clients();
        const body = byId('cli_body');
        if (!arr.length) {
            body.innerHTML = '<tr><td colspan="5" class="hint">keine aktiven Verbindungen</td></tr>';
            return;
        }
        body.innerHTML = arr
            .map(
                (c) =>
                    `<tr>` +
                    `<td data-label="Peer" style="font-family:ui-monospace,monospace">${escapeHtml(c.peer)}</td>` +
                    `<td data-label="Uptime" style="text-align:center">${fmtUptime(c.connected_ms)}</td>` +
                    `<td data-label="RX" style="text-align:right">${fmtBytes(c.rx_bytes)}</td>` +
                    `<td data-label="TX" style="text-align:right">${fmtBytes(c.tx_bytes)}</td>` +
                    `<td data-label="Frames" style="text-align:center">${c.rx_frames}</td>` +
                    `</tr>`
            )
            .join('');
    } catch {
        // silent
    }
}

// RSSI-Einordnung fuer den Status-Reiter. Ein Gateway, das Einmal-Telegramme
// (local_push) zuverlaessig fangen muss, will >= ~ -70 dBm.
function rssiQuality(r: number): string {
    if (!r) return 'n/a';
    if (r >= -60) return 'sehr gut';
    if (r >= -70) return 'gut';
    if (r >= -78) return 'schwach';
    return 'kritisch';
}

async function pollStats(): Promise<void> {
    if (activeTabName() !== 'status') return;
    try {
        const s = await api.stats();
        // Zeit-Basis fuer Telegramm-Zeitstempel (0 solange SNTP nicht sync).
        if (s.epoch_ms > 1_700_000_000_000) bootEpochMs = s.epoch_ms - s.uptime_ms;
        const clock = s.epoch_ms > 1_700_000_000_000
            ? new Date(s.epoch_ms).toLocaleString('de-DE')
            : 'nicht synchronisiert';
        byId('gwstat').textContent =
            `Uhrzeit (NTP) : ${clock}\n` +
            `IP-Adresse    : ${s.ip || '—'}\n` +
            `WLAN-Signal   : ${s.rssi ? `${s.rssi} dBm (${rssiQuality(s.rssi)})` : 'n/a'}\n` +
            `Uptime        : ${fmtUptime(s.uptime_ms)}\n` +
            `Aktive Clients: ${s.clients}`;
        byId('stats').textContent =
            `RX vom TCM515 : ${fmtBytes(s.tcm_rx_bytes)} / ${s.tcm_rx_frames} Frames\n` +
            `TX an TCM515  : ${fmtBytes(s.tcm_tx_bytes)} / ${s.tcm_tx_frames} Frames`;
    } catch {
        // silent
    }
}

// -----------------------------------------------------------------------------
// Telegramm-Feed: dekodiert die ESP3-Frames aus dem Konsolen-Stream und zeigt
// sie im Status-Reiter als Tabelle (Absender / RORG / Daten / dBm).
// -----------------------------------------------------------------------------
const TELE_MAX = 60;
const DIR_RX = '↓'; // empfangen vom TCM515
const DIR_TX = '↑'; // an den TCM515 gesendet

// epoch_ms - uptime_ms aus /api/stats. Sobald bekannt, werden Telegramm-
// Zeitstempel als echte Uhrzeit gerechnet (uptime der Zeile + diese Basis).
let bootEpochMs: number | null = null;

const RORG_NAMES: Record<number, string> = {
    0xf6: 'RPS', 0xd5: '1BS', 0xa5: '4BS', 0xd2: 'VLD',
    0xd1: 'MSC', 0xa6: 'ADT', 0xd4: 'UTE',
};

// Wippen-/Tastenbezeichnung fuer RPS (F6-02-xx).
const RPS_BUTTONS = ['Wippe A unten', 'Wippe A oben', 'Wippe B unten', 'Wippe B oben', 'Taste 5', 'Taste 6', 'Taste 7', 'Taste 8'];

// RPS (RORG F6): Schalter/Wippe. status-Bit NU (0x20) unterscheidet N-/U-Msg,
// DB0-Bit EB (0x10) = Energiebogen gedrueckt/losgelassen.
function describeRps(db0: number, status: number): string {
    const eb = (db0 & 0x10) !== 0;
    if ((status & 0x20) === 0) return eb ? 'Taste(n) gedrückt' : 'losgelassen';
    if (!eb && db0 === 0x00) return 'losgelassen';
    let s = `${RPS_BUTTONS[(db0 >> 5) & 0x07]} ${eb ? 'gedrückt' : 'losgelassen'}`;
    if (db0 & 0x01) s += ` + ${RPS_BUTTONS[(db0 >> 1) & 0x07]}`; // zweite Aktion
    return s;
}

// 1BS (RORG D5): einfacher Kontakt (z.B. Fenster/Tuer).
function describe1bs(db0: number): string {
    return db0 & 0x01 ? 'Kontakt geschlossen' : 'Kontakt offen';
}

// 4BS (RORG A5) als A5-38-08 Zentralkommando (was dieses Gateway schaltet).
// d = [DB3, DB2, DB1, DB0]; DB0-Bit 0x08 = Datentelegramm (sonst Lernen).
function describe4bs(d: number[]): string {
    if (d.length !== 4) return '';
    const db3 = d[0], db2 = d[1], db0 = d[3];
    if ((db0 & 0x08) === 0) return 'Lerntelegramm';
    if (db3 === 0x01) return db0 & 0x01 ? 'Einschalten' : 'Ausschalten';
    if (db3 === 0x02) return `Dimmen auf ${db2}%${db0 & 0x01 ? '' : ' (aus)'}`;
    return '';
}

function describeTelegram(rorg: number, payload: number[], status: number): string {
    if (rorg === 0xf6) return describeRps(payload[0] ?? 0, status);
    if (rorg === 0xd5) return describe1bs(payload[0] ?? 0);
    if (rorg === 0xa5) return describe4bs(payload);
    return '';
}

// Zeitstempel einer Telegramm-Zeile: echte Uhrzeit wenn SNTP-Basis bekannt,
// sonst Uptime-Sekunden als Fallback.
function fmtTelegramTime(ms: number): string {
    if (bootEpochMs === null) return (ms / 1000).toFixed(3);
    const d = new Date(bootEpochMs + ms);
    const p2 = (x: number) => String(x).padStart(2, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

interface Telegram {
    ms: number;
    dir: string;
    rorg: string;
    sender: string;
    data: string;
    text: string;
    dbm: number | null;
}

function toHex(arr: number[]): string {
    return arr.map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

function fmtEnoceanId(arr: number[]): string {
    return arr.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('-');
}

// Hex-Bytes aus einer Konsolenzeile "<prefix> : aa bb cc (NB)" ziehen.
function frameBytesFromLine(line: string): number[] | null {
    const ci = line.indexOf(' : ');
    if (ci < 0) return null;
    const bytes: number[] = [];
    for (const tok of line.slice(ci + 3).trim().split(/\s+/)) {
        if (/^[0-9a-fA-F]{2}$/.test(tok)) bytes.push(parseInt(tok, 16));
        else break; // "(14B)" oder "..." beendet den Hex-Teil
    }
    return bytes.length ? bytes : null;
}

// Minimaler ESP3-Parser (nur so weit wie fuer die Anzeige noetig).
function decodeEsp3(ms: number, dir: string, b: number[]): Telegram | null {
    if (b.length < 7 || b[0] !== 0x55) return null;
    const dataLen = (b[1] << 8) | b[2];
    const optLen = b[3];
    const type = b[4];
    const data = b.slice(6, 6 + dataLen);
    const opt = b.slice(6 + dataLen, 6 + dataLen + optLen);
    if (data.length < dataLen) return null;

    if (type !== 1) {
        // kein RADIO_ERP1 (z.B. RESPONSE 0x02) - Typ + Rohdaten zeigen
        return { ms, dir, rorg: `Typ 0x${type.toString(16).padStart(2, '0')}`, sender: '—', data: toHex(data), text: '', dbm: null };
    }
    if (dataLen < 6) return null;
    const rorg = data[0];
    const sender = data.slice(dataLen - 5, dataLen - 1);
    const status = data[dataLen - 1];
    const payload = data.slice(1, dataLen - 5);
    const dbm = optLen >= 6 && opt.length >= 6 ? -opt[5] : null;
    const name = RORG_NAMES[rorg] || `0x${rorg.toString(16).padStart(2, '0')}`;
    return { ms, dir, rorg: name, sender: fmtEnoceanId(sender), data: toHex(payload), text: describeTelegram(rorg, payload, status), dbm };
}

function renderTelegramRow(t: Telegram): string {
    const dbm = t.dbm === null ? '' : String(t.dbm);
    return (
        '<tr>' +
        `<td data-label="Zeit" style="font-family:ui-monospace,monospace">${fmtTelegramTime(t.ms)}</td>` +
        `<td data-label="Ri." style="text-align:center">${t.dir}</td>` +
        `<td data-label="RORG">${escapeHtml(t.rorg)}</td>` +
        `<td data-label="Absender" style="font-family:ui-monospace,monospace">${escapeHtml(t.sender)}</td>` +
        `<td data-label="Daten" style="font-family:ui-monospace,monospace">${escapeHtml(t.data)}</td>` +
        `<td data-label="Bedeutung">${escapeHtml(t.text)}</td>` +
        `<td data-label="dBm" style="text-align:right">${dbm}</td>` +
        '</tr>'
    );
}

// Baut aus einem Batch Konsolenzeilen die Telegramm-Zeilen und haengt sie oben
// an. Wird aus pollConsole gespeist (KEIN eigener HTTP-Poll mehr - sonst wird
// /api/console doppelt abgefragt und die WebUI ueber die WiFi-Strecke traege).
function renderTelegramLines(lines: ConsoleLine[]): void {
    const rows: string[] = [];
    for (const l of lines) {
        const dir = l.line.startsWith('<') ? DIR_RX : l.line.startsWith('>') ? DIR_TX : '';
        if (!dir) continue;
        const bytes = frameBytesFromLine(l.line);
        if (!bytes) continue;
        const t = decodeEsp3(l.ms, dir, bytes);
        if (t) rows.push(renderTelegramRow(t));
    }
    if (!rows.length) return;
    const body = byId('tel_body');
    if (body.querySelector('.hint')) body.innerHTML = '';
    body.insertAdjacentHTML('afterbegin', rows.reverse().join(''));
    while (body.children.length > TELE_MAX) body.removeChild(body.lastElementChild!);
}

let conSeq = 0;
let conPaused = false;

async function pollConsole(): Promise<void> {
    // Nur abfragen, wenn eine Ansicht die Daten wirklich braucht - spart der
    // WiFi-Strecke und dem kleinen HTTP-Server des ESP32 unnoetige Requests.
    const tab = activeTabName();
    if (tab !== 'status' && tab !== 'konsole') return;
    try {
        const j = await api.console(conSeq);
        conSeq = j.last_seq;
        if (!j.lines.length) return;

        // Telegramm-Tabelle (Status) immer fuellen, unabhaengig von der Pause.
        renderTelegramLines(j.lines);

        // Rohe Konsole nur schreiben, wenn nicht pausiert.
        if (conPaused) return;
        const el = byId<HTMLPreElement>('con');
        const chunk = j.lines
            .map((l) => {
                const t = (l.ms / 1000).toFixed(3).padStart(9, ' ');
                return `[${t}] ${l.line}`;
            })
            .join('\n');
        el.textContent = el.textContent ? el.textContent + '\n' + chunk : chunk;
        const lines = el.textContent.split('\n');
        if (lines.length > 400) el.textContent = lines.slice(-400).join('\n');
        if (byId<HTMLInputElement>('autoscroll').checked) {
            el.scrollTop = el.scrollHeight;
        }
    } catch {
        // silent
    }
}

// -----------------------------------------------------------------------------
// Konsole: Copy / Select-All / Clear / Pause
// -----------------------------------------------------------------------------
function selectConsoleContents(): void {
    const pre = byId('con');
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

async function copyConsole(): Promise<void> {
    const text = byId('con').textContent || '';
    if (!text) {
        say('Konsole ist leer');
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        say(`${text.length} Zeichen kopiert`);
    } catch {
        // Fallback: markieren, User macht Strg+C
        selectConsoleContents();
        say('Bitte manuell kopieren (Strg+C / Cmd+C)');
    }
}

function clearConsole(): void {
    // Nur die Anzeige leeren - den Cursor NICHT auf 0 zuruecksetzen. Sonst
    // wuerde der naechste Poll den kompletten Backlog nachladen (seit dem
    // gemeinsamen Cursor mit dem Telegramm-Feed) und bei vollem Ring haengen.
    byId('con').textContent = '';
    say('Konsole geleert');
}

function togglePause(): void {
    conPaused = !conPaused;
    byId('btn-pause').textContent = conPaused ? 'Weiter' : 'Pause';
    say(conPaused ? 'Konsole angehalten' : 'Konsole laeuft');
}

function wireConsoleKeyboard(): void {
    // Strg+A / Cmd+A: nur Konsolen-Inhalt selektieren wenn Konsole fokussiert
    const pre = byId<HTMLPreElement>('con');
    pre.addEventListener('keydown', (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            selectConsoleContents();
        }
    });

    // Wenn der User im Konsole-Tab Strg+A drueckt und die Konsole NICHT den
    // Fokus hat, trotzdem Konsole selektieren statt der ganzen Seite
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
        const konsoleActive = document.getElementById('tab-konsole')?.classList.contains('active');
        if (!konsoleActive) return;
        // Wenn der Fokus in einem Eingabefeld liegt, Standard-Verhalten
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        e.preventDefault();
        selectConsoleContents();
    });
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
function init(): void {
    initTabs();
    wireEyeToggles();
    tokenDisplay = new SecretDisplay(byId('token'));
    adminDisplay = new SecretDisplay(byId('adminp'));
    apiTokenDisplay = new SecretDisplay(byId('api_token'));

    byId('btn-scan').addEventListener('click', doScan);
    byId('btn-regen').addEventListener('click', doRegenToken);
    byId('btn-regen2').addEventListener('click', doRegenToken);
    byId('btn-save').addEventListener('click', doSave);
    byId('btn-factory').addEventListener('click', doFactoryReset);
    byId('btn-clear').addEventListener('click', clearConsole);
    byId('btn-pause').addEventListener('click', togglePause);
    byId('btn-copy').addEventListener('click', copyConsole);
    byId('btn-preset-ha').addEventListener('click', applyHAPreset);

    wireConsoleKeyboard();

    void loadState();
    void doScan();
    setInterval(pollClients, 3000);
    setInterval(pollStats, 3000);
    setInterval(pollConsole, 1000);
    void pollClients();
    void pollStats();
    void pollConsole();
}

init();
