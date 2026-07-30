// EUL Konfigurations-Portal (Frontend).
//
// Wird via esbuild in ein einzelnes IIFE gebundelt, in index.html
// eingebettet und dann als C-String in main/portal_html.h abgelegt.

import { EEP_CATALOG } from './eep_catalog';
import { eoApp } from './eo/app';
import { describeTelegram, eepFromTeachIn4bs } from './eo/eep_decode';
import { initDevicesTab, renderTable as renderDeviceList } from './eo/ui_devices';
import { initHaTab, syncHaGateway } from './eo/ui_ha';
import { initPct14Tab, initToolsTab, updateStorageInfo } from './eo/ui_tools';
import { SEGMENT_COLORS, type FrameSegmentKind } from './eo/telegram';

// -----------------------------------------------------------------------------
// Types (spiegeln HTTP-Backend)
// -----------------------------------------------------------------------------
type Mode = 'provisioning' | 'normal';

interface State {
    mode: Mode;
    suffix: string;
    wifi_ssid: string;
    wifi_pass: string;
    usb_enabled: boolean;
    tcp_enabled: boolean;
    tcp_port: number;
    tcp_auth_required: boolean;
    tcp_token: string;
    ota_token: string;
    admin_pass: string;
    api_enabled: boolean;
    device_name: string;
    admin_user: string;
    ntp_server: string;
    tz: string;
    fw_version: string;
    fw_build: number;
    fw_git: string;
    fw_date: string;
    fw_part: string;
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
    tx_dropped: number;   // verworfen, weil der Client zu langsam liest
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
    fs_total: number;   // SPIFFS gesamt (Geraete-Inventar)
    fs_used: number;    // SPIFFS belegt
    eo_bytes: number;   // Groesse des gespeicherten Geraete-Dokuments
    heap_free: number;
    heap_max: number;
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

interface EvtLine {
    seq: number;
    ms: number;
    ts: number;   // epoch ms (0 = nicht synchron)
    lvl: number;  // 0=info 1=warn 2=err
    tag: string;
    msg: string;
}

interface EventResp {
    events: EvtLine[];
    last_seq: number;
}

interface SaveBody {
    tcp_enabled: boolean;
    tcp_port: number;
    tcp_auth_required: boolean;
    usb_enabled: boolean;
    api_enabled: boolean;
    device_name: string;
    admin_user: string;
    ntp_server: string;
    tz: string;
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
type TabName =
    | 'status' | 'allgemein' | 'wifi' | 'usb' | 'enocean'
    | 'geraete' | 'ha' | 'werkzeuge' | 'pct14' | 'api' | 'events' | 'konsole';

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
    // Der HA-Reiter zeigt Base-ID/Host/Port des EnOcean-Reiters. Beim
    // Hereinwechseln neu uebernehmen, damit z.B. ein gerade geaenderter Port
    // dort sofort richtig steht.
    if (name === 'ha') syncHaGateway();
}

// Die Reiterleiste klebt unter der Kopfzeile. Deren Hoehe haengt vom
// Geraetenamen und der Fensterbreite ab (Umbruch), deshalb wird sie gemessen
// statt geraten und als CSS-Variable bereitgestellt.
function trackHeaderHeight(): void {
    const header = document.querySelector<HTMLElement>('header');
    if (!header) return;
    const apply = () => {
        document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
    };
    apply();
    // Deckt auch das Umbrechen der Ueberschrift ab, das ein reines
    // resize-Event auf dem Fenster nicht zuverlaessig meldet.
    new ResizeObserver(apply).observe(header);
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
    events: (since: number): Promise<EventResp> => apiJson(`/api/events?since=${since}`),
    save: (body: SaveBody): Promise<{ ok: boolean }> =>
        apiJson('/api/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
    regenToken: (): Promise<{ token: string }> => apiJson('/api/regen-token', { method: 'POST' }),
    regenOtaToken: (): Promise<{ token: string }> => apiJson('/api/regen-ota-token', { method: 'POST' }),
    factoryReset: (): Promise<{ ok: boolean }> => apiJson('/api/factory-reset', { method: 'POST' }),
    reboot: (): Promise<{ ok: boolean }> => apiJson('/api/reboot', { method: 'POST' }),
    baseIdRead: (): Promise<BaseIdResp> => apiJson('/api/baseid', { method: 'GET' }),
    baseIdWrite: (base_id: string): Promise<BaseIdResp> =>
        apiJson('/api/baseid', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ base_id }),
        }),
};

interface BaseIdResp {
    base_id: string;          // "FF-AA-00-00"
    writes_remaining?: number; // vom TCM gemeldete Rest-Schreibzugriffe
}

// Gaengige Zeitzonen: Anzeigename -> POSIX-TZ-String (mit DST-Regel).
const TZ_ZONES: Array<[string, string]> = [
    ['Europe/Berlin (Amsterdam, Paris, Rom, Madrid)', 'CET-1CEST,M3.5.0,M10.5.0/3'],
    ['Europe/London (Dublin, Lissabon)', 'GMT0BST,M3.5.0/1,M10.5.0'],
    ['Europe/Athen (Helsinki, Bukarest)', 'EET-2EEST,M3.5.0/3,M10.5.0/4'],
    ['Europe/Moskau', 'MSK-3'],
    ['UTC', 'UTC0'],
    ['America/New York', 'EST5EDT,M3.2.0,M11.1.0'],
    ['America/Chicago', 'CST6CDT,M3.2.0,M11.1.0'],
    ['America/Denver', 'MST7MDT,M3.2.0,M11.1.0'],
    ['America/Los Angeles', 'PST8PDT,M3.2.0,M11.1.0'],
    ['America/Sao Paulo', '<-03>3'],
    ['Asia/Dubai', '<+04>-4'],
    ['Asia/Kolkata (Indien)', 'IST-5:30'],
    ['Asia/Shanghai (China)', 'CST-8'],
    ['Asia/Tokio', 'JST-9'],
    ['Australia/Sydney', 'AEST-10AEDT,M10.1.0,M4.1.0/3'],
];

function populateTz(): void {
    const sel = byId<HTMLSelectElement>('tz');
    sel.innerHTML = '';
    for (const [label, tz] of TZ_ZONES) {
        const o = document.createElement('option');
        o.value = tz;
        o.textContent = label;
        sel.appendChild(o);
    }
}

function setTz(tz: string): void {
    const sel = byId<HTMLSelectElement>('tz');
    if (tz && !Array.from(sel.options).some((o) => o.value === tz)) {
        const o = document.createElement('option');
        o.value = tz;
        o.textContent = `Eigene (${tz})`;
        sel.appendChild(o);
    }
    sel.value = tz || 'CET-1CEST,M3.5.0,M10.5.0/3';
}

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
let otaTokenDisplay: SecretDisplay;

// Fuer /api/send aus dem Werkzeuge-Reiter: der Geraete-Token gilt nur, wenn
// die REST-API auch eingeschaltet ist.
let apiToken = '';
let apiEnabled = false;

async function loadState(): Promise<void> {
    try {
        const s = await api.state();
        byId<HTMLInputElement>('ssid').value = s.wifi_ssid || '';
        byId<HTMLInputElement>('pass').value = s.wifi_pass || '';
        byId<HTMLInputElement>('tcp_en').checked = s.tcp_enabled;
        byId<HTMLInputElement>('tcp_port').value = String(s.tcp_port);
        byId<HTMLInputElement>('tcp_auth').checked = s.tcp_auth_required;
        byId<HTMLInputElement>('usb_en').checked = s.usb_enabled;
        tokenDisplay.set(s.tcp_token);
        adminDisplay.set(s.admin_pass);
        byId<HTMLInputElement>('api_en').checked = s.api_enabled;
        apiTokenDisplay.set(s.tcp_token);
        otaTokenDisplay.set(s.ota_token);
        byId<HTMLInputElement>('dev_name').value = s.device_name || '';
        byId<HTMLInputElement>('admin_user').value = s.admin_user || 'admin';
        byId<HTMLInputElement>('ntp_server').value = s.ntp_server || 'pool.ntp.org';
        setTz(s.tz);
        byId('fw_info').textContent =
            `Version  : ${s.fw_version}  (Build ${s.fw_build})\n` +
            `Git      : ${s.fw_git}\n` +
            `Datum    : ${s.fw_date}\n` +
            `Partition: ${s.fw_part}`;
        const h1 = document.querySelector('header h1');
        if (h1 && s.device_name) h1.textContent = s.device_name;
        // Browser-Tab-Titel ebenfalls auf den vergebenen Geraetenamen setzen
        // (nicht nur die Ueberschrift). Ohne Namen bleibt der statische <title>.
        if (s.device_name) document.title = s.device_name;
        apiToken = s.tcp_token;
        apiEnabled = s.api_enabled;
        renderApiDoc(s.tcp_token, s.api_enabled);
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
        sel.innerHTML = '<option value="">— Netzwerk wählen —</option>';
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

async function doRegenOtaToken(): Promise<void> {
    try {
        const r = await api.regenOtaToken();
        otaTokenDisplay.set(r.token);
        say('neuer OTA-Token');
    } catch (e) {
        say(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// TCM515 Base-ID lesen (ESP3 CO_RD_IDBASE). Ergebnis in Feld + Anzeige.
async function doReadBaseId(): Promise<void> {
    const out = byId('baseid_info');
    out.textContent = 'lese ...';
    try {
        const r = await api.baseIdRead();
        byId<HTMLInputElement>('baseid_in').value = r.base_id;
        publishBaseId();
        out.textContent = r.writes_remaining !== undefined
            ? `Base-ID: ${r.base_id} · noch ${r.writes_remaining} Schreibzugriffe`
            : `Base-ID: ${r.base_id}`;
        say('Base-ID gelesen');
    } catch (e) {
        out.textContent = `Fehler: ${e instanceof Error ? e.message : String(e)}`;
    }
}

// TCM515 Base-ID schreiben (ESP3 CO_WR_IDBASE). Nur ~10 Schreibzugriffe je Modul!
async function doWriteBaseId(): Promise<void> {
    const val = byId<HTMLInputElement>('baseid_in').value.trim().toUpperCase();
    // Gueltiger Bereich laut TCM-Datenblatt: FF800000 .. FFFFFF80.
    if (!/^FF-?[0-9A-F]{2}-?[0-9A-F]{2}-?[0-9A-F]{2}$/.test(val)) {
        say('Base-ID-Format: FF-xx-xx-xx (Hex, beginnt mit FF)');
        return;
    }
    if (!confirm('Base-ID wirklich schreiben? Der TCM515 erlaubt nur rund 10 Schreibvorgänge insgesamt.')) return;
    const out = byId('baseid_info');
    out.textContent = 'schreibe ...';
    try {
        const r = await api.baseIdWrite(val);
        byId<HTMLInputElement>('baseid_in').value = r.base_id;
        publishBaseId();
        out.textContent = r.writes_remaining !== undefined
            ? `Neue Base-ID: ${r.base_id} · noch ${r.writes_remaining} Schreibzugriffe`
            : `Neue Base-ID: ${r.base_id}`;
        say('Base-ID geschrieben');
    } catch (e) {
        out.textContent = `Fehler: ${e instanceof Error ? e.message : String(e)}`;
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
    // Die tatsaechlich gelesene Base-ID einsetzen. Frueher stand hier ein
    // Platzhalter, der sich vom erzeugten Block im HA-Reiter unterschied.
    const base = byId<HTMLInputElement>('baseid_in').value.trim().toUpperCase();
    const yaml =
        'eltako:\n' +
        '  gateway:\n' +
        '    - id: 1\n' +
        '      device_type: eul_lan\n' +
        `      serial_path: ${host}\n` +
        `      port: ${port}\n` +
        (base
            ? `      base_id: ${base}\n`
            : '      base_id: FF-AA-00-00     # noch nicht gelesen - Knopf „Lesen" oben\n');
    byId('ha_yaml').textContent = yaml;
    byId('ha_yaml_box').style.display = 'block';
}

// Die Base-ID des TCM515 ist die einzige Quelle fuer alles, was mit
// Sender-Adressen rechnet: HA-Export, Telegramm-Sender, PCT14. Sie wird hier
// im EnOcean-Reiter gepflegt und von dort in den Geraete-Manager gespiegelt.
function publishBaseId(): void {
    const v = byId<HTMLInputElement>('baseid_in').value.trim().toUpperCase();
    if (v === eoApp.doc.baseId) return;
    eoApp.doc.baseId = v;
    eoApp.touch();
    syncHaGateway();
    if (byId('ha_yaml_box').style.display !== 'none') renderHAYaml();
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

async function doSave(): Promise<void> {
    const body: SaveBody = {
        tcp_enabled: byId<HTMLInputElement>('tcp_en').checked,
        tcp_port: parseInt(byId<HTMLInputElement>('tcp_port').value, 10) || 5100,
        tcp_auth_required: byId<HTMLInputElement>('tcp_auth').checked,
        usb_enabled: byId<HTMLInputElement>('usb_en').checked,
        api_enabled: byId<HTMLInputElement>('api_en').checked,
        device_name: byId<HTMLInputElement>('dev_name').value.trim(),
        admin_user: byId<HTMLInputElement>('admin_user').value.trim(),
        ntp_server: byId<HTMLInputElement>('ntp_server').value.trim(),
        tz: byId<HTMLSelectElement>('tz').value,
    };
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
        if (!confirm('WLAN-Zugang bleibt unverändert (nur SSID oder Passwort eingetragen). Fortfahren?')) return;
    }
    try {
        await api.save(body);
        say('gespeichert — Neustart nötig für WLAN/TCP/Name/Zeitzone');
    } catch (e) {
        say(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function doReboot(): Promise<void> {
    if (!confirm('Gerät jetzt neu starten? Die Verbindung wird kurz getrennt.')) return;
    try {
        await api.reboot();
        say('Neustart ausgeloest ...');
    } catch (e) {
        say(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// Nach erfolgreichem OTA: warten bis das Geraet aus dem Reboot zurueck ist,
// dann Portal neu laden (zeigt direkt die neue Versionsnummer).
async function waitForDeviceBack(prog: HTMLElement): Promise<void> {
    const t0 = Date.now();
    // Reboot beginnt ~0.5 s nach der Antwort; die ersten Sekunden nicht pollen.
    await new Promise((r) => setTimeout(r, 3000));
    while (Date.now() - t0 < 120000) {
        const sec = Math.round((Date.now() - t0) / 1000);
        prog.textContent = `Gerät startet neu ... warte auf Wiederverbindung (${sec}s)`;
        try {
            const ctl = new AbortController();
            const to = setTimeout(() => ctl.abort(), 1500);
            const r = await fetch('/api/state', { signal: ctl.signal, cache: 'no-store' });
            clearTimeout(to);
            if (r.ok) {
                prog.textContent = 'Update abgeschlossen — Portal wird neu geladen ...';
                setTimeout(() => location.reload(), 800);
                return;
            }
        } catch { /* noch nicht erreichbar -> weiter pollen */ }
        await new Promise((r) => setTimeout(r, 1500));
    }
    prog.textContent = 'Gerät meldet sich nicht zurück — Seite bitte manuell neu laden.';
}

function doOtaUpload(): void {
    const input = byId<HTMLInputElement>('ota_file');
    const file = input.files && input.files[0];
    if (!file) { say('Bitte zuerst eine .bin-Datei wählen'); return; }
    if (!confirm(`Firmware "${file.name}" (${fmtBytes(file.size)}) einspielen? Das Gerät startet danach neu.`)) return;

    const prog = byId('ota_progress');
    const wrap = byId('ota_bar_wrap');
    const bar = byId('ota_bar');
    const btn = byId<HTMLButtonElement>('btn-ota');
    btn.disabled = true;
    wrap.style.display = 'block';
    wrap.classList.remove('indet');
    bar.style.width = '0%';

    // XHR statt fetch, um den Upload-Fortschritt anzuzeigen. Basic-Auth wird vom
    // Browser (same-origin) automatisch mitgeschickt.
    const xhr = new XMLHttpRequest();
    const t0 = Date.now();
    xhr.open('POST', '/api/ota');
    xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = (e.loaded / e.total) * 100;
        bar.style.width = `${pct.toFixed(1)}%`;
        const dt = (Date.now() - t0) / 1000;
        const rate = dt > 0.3 ? e.loaded / dt : 0;
        const eta = rate > 0 ? Math.max(1, Math.round((e.total - e.loaded) / rate)) : 0;
        prog.textContent =
            `Upload ${Math.round(pct)} %  ·  ${fmtBytes(e.loaded)} / ${fmtBytes(e.total)}` +
            (rate > 0 ? `  ·  ${fmtBytes(rate)}/s  ·  noch ~${eta}s` : '');
    };
    // Alle Bytes sind raus - jetzt validiert das Geraet das Image und setzt die
    // Boot-Partition. Dauert ein paar Sekunden ohne Byte-Fortschritt.
    xhr.upload.onload = () => {
        bar.style.width = '100%';
        wrap.classList.add('indet');
        prog.textContent = 'Upload fertig — Gerät prüft und aktiviert das Image ...';
    };
    xhr.onload = () => {
        wrap.classList.remove('indet');
        if (xhr.status === 200) {
            bar.style.width = '100%';
            say('Firmware aktualisiert, Neustart');
            void waitForDeviceBack(prog);
        } else {
            btn.disabled = false;
            wrap.style.display = 'none';
            prog.textContent = `Fehler ${xhr.status}: ${xhr.responseText}`;
            say('OTA fehlgeschlagen');
        }
    };
    xhr.onerror = () => {
        btn.disabled = false;
        wrap.classList.remove('indet');
        wrap.style.display = 'none';
        prog.textContent = 'Upload-Fehler (Verbindung abgebrochen). Nochmal versuchen.';
    };
    prog.textContent = 'Upload startet ...';
    xhr.send(file);
}

async function doFactoryReset(): Promise<void> {
    if (!confirm('Wirklich auf Werkseinstellungen zurücksetzen? Alle Zugangsdaten werden neu erzeugt.')) return;
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
            body.innerHTML = '<tr><td colspan="6" class="hint">keine aktiven Verbindungen</td></tr>';
            return;
        }
        body.innerHTML = arr
            .map((c) => {
                // Verworfene Bytes hervorheben: > 0 heisst, der Client liest zu
                // langsam und hat Telegramme verpasst.
                const drop = c.tx_dropped || 0;
                const dropCell = drop > 0
                    ? `<b style="color:var(--danger)">${fmtBytes(drop)}</b>`
                    : '—';
                return `<tr>` +
                    `<td data-label="Peer" style="font-family:ui-monospace,monospace">${escapeHtml(c.peer)}</td>` +
                    `<td data-label="Uptime" style="text-align:center">${fmtUptime(c.connected_ms)}</td>` +
                    `<td data-label="RX" style="text-align:right">${fmtBytes(c.rx_bytes)}</td>` +
                    `<td data-label="TX" style="text-align:right">${fmtBytes(c.tx_bytes)}</td>` +
                    `<td data-label="Frames" style="text-align:center">${c.rx_frames}</td>` +
                    `<td data-label="Verworfen" style="text-align:right">${dropCell}</td>` +
                    `</tr>`;
            })
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
    // Der PCT14-Reiter zeigt die Speicherbelegung aus derselben Antwort.
    const tab = activeTabName();
    if (tab !== 'status' && tab !== 'pct14') return;
    try {
        const s = await api.stats();
        updateStorageInfo(s.fs_total, s.fs_used, s.eo_bytes);
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
            `Aktive Clients: ${s.clients}\n` +
            `Freier Heap   : ${fmtBytes(s.heap_free)}\n` +
            `Größter Block : ${fmtBytes(s.heap_max)}`;
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

// ESP3-Pakettyp (Byte 4 des Frames) -> Anzeigename fuer die Spalte "Typ".
const ESP3_TYPES: Record<number, string> = {
    0x01: 'Funk (ERP1)', 0x02: 'Antwort', 0x03: 'Sub-Tel', 0x04: 'Event',
    0x05: 'Command', 0x06: 'Smart-Ack', 0x07: 'Remote-Man', 0x09: 'Funk (ERP2)',
    0x0a: '802.15.4', 0x0b: 'Command 2.4',
};

// Deutung eines empfangenen Telegramms. Die eigentliche Dekodierung liegt in
// eo/eep_decode.ts (teilt sich der Geraete-Manager mit dem EEP-Pruefer); hier
// bleibt nur die Anbindung an den Geraetebestand: Lerntelegramme setzen das
// EEP des Absenders, danach dekodiert der Katalog.
function describeTelegramForSender(
    rorg: number,
    payload: number[],
    status: number,
    sender: string,
): string {
    if (rorg === 0xa5) {
        const learned = eepFromTeachIn4bs(payload);
        if (learned) {
            eoApp.learnEep(sender, learned);
            const t = EEP_CATALOG[learned]?.t;
            return `Lerntelegramm ${learned}${t ? ': ' + t : ''}`;
        }
    }
    return describeTelegram(rorg, payload, status, eoApp.eepFor(sender));
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
    typ: string;
    rorg: string;
    sender: string;
    data: string;
    text: string;
    dbm: number | null;
    rep: number; // Repeater-Hops aus dem Status-Byte (0 = direkt/original)
    raw: number[]; // kompletter ESP3-Frame (Sync..CRC8D) für die Feld-Zerlegung
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
    const typ = ESP3_TYPES[type] || `0x${type.toString(16).padStart(2, '0')}`;

    if (type !== 1) {
        // kein RADIO_ERP1 (z.B. RESPONSE 0x02) - Typ + Rohdaten zeigen
        return { ms, dir, typ, rorg: '—', sender: '—', data: toHex(data), text: '', dbm: null, rep: 0, raw: b };
    }
    if (dataLen < 6) return null;
    const rorg = data[0];
    const sender = data.slice(dataLen - 5, dataLen - 1);
    const status = data[dataLen - 1];
    const payload = data.slice(1, dataLen - 5);
    const dbm = optLen >= 6 && opt.length >= 6 ? -opt[5] : null;
    // EnOcean-Status-Byte: untere 4 Bit = Repeater-Zaehler (0 = nicht wiederholt).
    const rep = status & 0x0f;
    const rorgHex = `0x${rorg.toString(16).padStart(2, '0')}`;
    const name = RORG_NAMES[rorg] ? `${RORG_NAMES[rorg]} (${rorgHex})` : rorgHex;
    const senderStr = fmtEnoceanId(sender);
    // Absender in den Geraetebestand aufnehmen bzw. dessen Laufzeitwerte
    // (Signal, letzte Sichtung) auffrischen. Nur Empfangsrichtung: was WIR
    // senden, ist kein fremdes Geraet.
    if (dir === DIR_RX) {
        // Ohne NTP-Basis die Browser-Uhr nehmen: die Zeile ist hoechstens eine
        // Poll-Runde alt, das ist genauer als "nie gesehen".
        eoApp.noteTelegram(senderStr, rorg, dbm, bootEpochMs === null ? Date.now() : bootEpochMs + ms);
    }
    return {
        ms, dir, typ, rorg: name, sender: senderStr, data: toHex(payload),
        text: describeTelegramForSender(rorg, payload, status, senderStr), dbm, rep, raw: b,
    };
}

// ESP3-Frame feldweise zerlegen (für die aufklappbare Rohframe-Ansicht).
// Dieselbe Farbcodierung wie im Sende-Werkzeug: gleiche Farbe = gleiches Feld.
interface RawField { name: string; hex: string; kind: FrameSegmentKind; }
function hx1(b: number[], i: number): string {
    return i >= 0 && i < b.length ? b[i].toString(16).padStart(2, '0') : '??';
}
function hxRange(b: number[], from: number, to: number): string {
    return b.slice(from, to).map((x) => x.toString(16).padStart(2, '0')).join(' ') || '—';
}
function esp3Fields(b: number[]): RawField[] {
    const f: RawField[] = [];
    if (b.length < 6 || b[0] !== 0x55) return f;
    const dataLen = (b[1] << 8) | b[2];
    const optLen = b[3];
    const type = b[4];
    f.push({ name: 'Sync', hex: hx1(b, 0), kind: 'frame' });
    f.push({ name: 'Data Length', hex: hxRange(b, 1, 3), kind: 'frame' });
    f.push({ name: 'Opt. Length', hex: hx1(b, 3), kind: 'frame' });
    f.push({ name: 'Packet Type', hex: hx1(b, 4), kind: 'frame' });
    f.push({ name: 'CRC8H', hex: hx1(b, 5), kind: 'crc' });
    const dataStart = 6;
    const dataEnd = 6 + dataLen;
    if (type === 1 && dataLen >= 6) {
        f.push({ name: 'RORG', hex: hx1(b, dataStart), kind: 'org' });
        f.push({ name: 'Data', hex: hxRange(b, dataStart + 1, dataEnd - 5), kind: 'data' });
        f.push({ name: 'Sender-ID', hex: hxRange(b, dataEnd - 5, dataEnd - 1), kind: 'address' });
        f.push({ name: 'Status', hex: hx1(b, dataEnd - 1), kind: 'status' });
        const os = dataEnd;
        if (optLen >= 1) f.push({ name: 'SubTelNum', hex: hx1(b, os), kind: 'optional' });
        if (optLen >= 5) f.push({ name: 'Destination', hex: hxRange(b, os + 1, os + 5), kind: 'optional' });
        if (optLen >= 6) f.push({ name: 'dBm', hex: hx1(b, os + 5), kind: 'optional' });
        if (optLen >= 7) f.push({ name: 'Security', hex: hx1(b, os + 6), kind: 'optional' });
    } else {
        f.push({ name: 'Data', hex: hxRange(b, dataStart, dataEnd), kind: 'data' });
        if (optLen > 0) f.push({ name: 'Optional', hex: hxRange(b, dataEnd, dataEnd + optLen), kind: 'optional' });
    }
    const crcd = 6 + dataLen + optLen;
    f.push({ name: 'CRC8D', hex: hx1(b, crcd), kind: 'crc' });
    return f;
}

function renderTelegramRow(t: Telegram): string {
    const dbm = t.dbm === null ? '' : String(t.dbm);
    const nm = eoApp.nameFor(t.sender);
    const senderCell = `<span style="font-family:ui-monospace,monospace">${escapeHtml(t.sender)}</span>` +
        (nm ? ` <b>${escapeHtml(nm)}</b>` : '');
    // Wiederholte Telegramme (über Repeater) markieren: 🔁 + Hop-Anzahl.
    const repBadge = t.rep > 0
        ? ` <span title="über ${t.rep} Repeater wiederholt" style="color:#c47f00">🔁${t.rep}</span>`
        : '';
    const search = `${t.sender} ${nm || ''} ${t.rorg} ${t.typ} ${t.text}`.toLowerCase();
    const bg = t.rep > 0 ? 'background:rgba(196,127,0,0.10);' : '';
    return (
        `<tr class="tel-row" data-frame="${toHex(t.raw)}" data-search="${escapeHtml(search)}" title="Klicken: ESP3-Rohframe feldweise zerlegt" style="cursor:pointer;${bg}">` +
        `<td data-label="Zeit" style="font-family:ui-monospace,monospace">${fmtTelegramTime(t.ms)}</td>` +
        `<td data-label="Ri." style="text-align:center;white-space:nowrap">${t.dir}${repBadge}</td>` +
        `<td data-label="Typ">${escapeHtml(t.typ)}</td>` +
        `<td data-label="RORG">${escapeHtml(t.rorg)}</td>` +
        `<td data-label="Absender">${senderCell}</td>` +
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
    // Prune: nur Hauptzeilen zaehlen; zugehoerige Detailzeilen mit entfernen.
    let mains = body.querySelectorAll<HTMLTableRowElement>('tr.tel-row');
    while (mains.length > TELE_MAX) {
        const last = mains[mains.length - 1];
        const nx = last.nextElementSibling;
        if (nx && nx.classList.contains('tel-detail')) nx.remove();
        last.remove();
        mains = body.querySelectorAll<HTMLTableRowElement>('tr.tel-row');
    }
    applyTelegramFilter();
}

const TEL_COLS = 8; // Spaltenzahl der Telegramm-Tabelle (fuer colspan der Detailzeile)
let telFilter = '';

// Rohframe-Detailzeile bauen: ESP3-Felder als eigene Spalten + Rohhex.
function buildTelDetail(frameHex: string): HTMLTableRowElement {
    const bytes = frameHex.trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16));
    const fields = esp3Fields(bytes);
    const tr = document.createElement('tr');
    tr.className = 'tel-detail';
    if (!fields.length) {
        tr.innerHTML = `<td colspan="${TEL_COLS}" class="hint">Rohframe nicht verfügbar</td>`;
        return tr;
    }
    const color = (f: RawField) => SEGMENT_COLORS[f.kind];
    const heads = fields
        .map((f) => `<th style="color:${color(f)}">${escapeHtml(f.name)}</th>`)
        .join('');
    const vals = fields
        .map((f) => `<td style="color:${color(f)}">${escapeHtml(f.hex)}</td>`)
        .join('');
    // Die Rohframe-Zeile in denselben Farben wie die Tabelle darunter - so
    // sieht man auf einen Blick, welches Byte wozu gehoert.
    const raw = fields
        .map((f) => `<span title="${escapeHtml(f.name)}" style="color:${color(f)}">${escapeHtml(f.hex)}</span>`)
        .join(' ');
    tr.innerHTML =
        `<td colspan="${TEL_COLS}"><div class="rawwrap">` +
        `<div class="rawhex">${raw}</div>` +
        `<table class="rawtbl"><thead><tr>${heads}</tr></thead><tbody><tr>${vals}</tr></tbody></table>` +
        `</div></td>`;
    return tr;
}

// Filter (Absender/Name/RORG/Typ/Bedeutung) auf alle Telegramm-Zeilen anwenden.
function applyTelegramFilter(): void {
    const body = byId('tel_body');
    body.querySelectorAll<HTMLTableRowElement>('tr.tel-row').forEach((r) => {
        const match = !telFilter || (r.getAttribute('data-search') || '').includes(telFilter);
        r.style.display = match ? '' : 'none';
        const nx = r.nextElementSibling as HTMLElement | null;
        if (nx && nx.classList.contains('tel-detail')) nx.style.display = match ? '' : 'none';
    });
}

let conSeq = 0;
let conPaused = false;

async function pollConsole(): Promise<void> {
    // Nur abfragen, wenn eine Ansicht die Daten wirklich braucht - spart der
    // WiFi-Strecke und dem kleinen HTTP-Server des ESP32 unnoetige Requests.
    const tab = activeTabName();
    if (tab !== 'status' && tab !== 'konsole' && tab !== 'geraete') return;
    try {
        const j = await api.console(conSeq);
        conSeq = j.last_seq;
        if (!j.lines.length) return;

        // Telegramm-Tabelle (Status) immer fuellen, unabhaengig von der Pause.
        renderTelegramLines(j.lines);
        // Signal und "Zuletzt gesehen" aendern sich mit jedem Telegramm, loesen
        // aber bewusst kein Speichern aus - deshalb hier explizit neu zeichnen,
        // und nur wenn der Reiter auch sichtbar ist.
        if (tab === 'geraete') renderDeviceList();

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
// Events-Reiter (strukturierte Debug-Ereignisse)
// -----------------------------------------------------------------------------
let evtSeq = 0;
const EVT_MAX = 200;
const EVT_LABEL = ['INFO', 'WARN', 'FEHLER'];
const EVT_COLOR = ['var(--hint)', '#c47f00', 'var(--danger)'];

function fmtEventTime(ms: number, ts: number): string {
    if (ts > 0) {
        const d = new Date(ts);
        const p2 = (x: number) => String(x).padStart(2, '0');
        return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    }
    return `${(ms / 1000).toFixed(1)}s`;
}

function renderEventRow(e: EvtLine): string {
    const lvl = e.lvl >= 0 && e.lvl <= 2 ? e.lvl : 0;
    return (
        '<tr>' +
        `<td data-label="Zeit" style="font-family:ui-monospace,monospace;white-space:nowrap">${fmtEventTime(e.ms, e.ts)}</td>` +
        `<td data-label="Level" style="color:${EVT_COLOR[lvl]};font-weight:600">${EVT_LABEL[lvl]}</td>` +
        `<td data-label="Quelle" style="font-family:ui-monospace,monospace">${escapeHtml(e.tag)}</td>` +
        `<td data-label="Meldung">${escapeHtml(e.msg)}</td>` +
        '</tr>'
    );
}

async function pollEvents(): Promise<void> {
    if (activeTabName() !== 'events') return;
    try {
        const j = await api.events(evtSeq);
        evtSeq = j.last_seq;
        if (!j.events.length) return;
        const body = byId('evt_body');
        if (body.querySelector('.hint')) body.innerHTML = '';
        body.insertAdjacentHTML('afterbegin', j.events.map(renderEventRow).reverse().join(''));
        while (body.children.length > EVT_MAX) body.removeChild(body.lastElementChild!);
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
    say(conPaused ? 'Konsole angehalten' : 'Konsole läuft');
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
// Geraete-Manager: erst den Bestand vom Geraet holen, dann die drei Reiter
// aufbauen. Laeuft parallel zum uebrigen Portal-Start - ein langsamer
// /api/eo-Request darf Status und Konsole nicht aufhalten.
async function initEo(): Promise<void> {
    await eoApp.init({
        say,
        host: currentHost,
        tcpPort: () => parseInt(byId<HTMLInputElement>('tcp_port').value, 10) || 5100,
        apiToken: () => (apiEnabled ? apiToken : ''),
    });
    // Gespeicherte Base-ID ins Eingabefeld des EnOcean-Reiters zuruecklegen:
    // sie steht dann nach jedem Portal-Aufruf da, ohne den TCM515 erneut
    // auslesen zu muessen.
    const baseIn = byId<HTMLInputElement>('baseid_in');
    if (!baseIn.value && eoApp.doc.baseId) baseIn.value = eoApp.doc.baseId;
    baseIn.addEventListener('input', publishBaseId);

    initDevicesTab();
    initHaTab();
    initToolsTab();
    initPct14Tab();
}

function init(): void {
    initTabs();
    trackHeaderHeight();
    wireEyeToggles();
    tokenDisplay = new SecretDisplay(byId('token'));
    adminDisplay = new SecretDisplay(byId('adminp'));
    apiTokenDisplay = new SecretDisplay(byId('api_token'));
    otaTokenDisplay = new SecretDisplay(byId('ota_token'));

    byId('btn-scan').addEventListener('click', doScan);
    byId('btn-regen').addEventListener('click', doRegenToken);
    byId('btn-regen2').addEventListener('click', doRegenToken);
    byId('btn-regen-ota').addEventListener('click', doRegenOtaToken);
    byId('btn-save').addEventListener('click', doSave);
    byId('btn-reboot').addEventListener('click', doReboot);
    byId('btn-ota').addEventListener('click', doOtaUpload);
    byId('btn-factory').addEventListener('click', doFactoryReset);
    byId('btn-clear').addEventListener('click', clearConsole);
    byId('btn-pause').addEventListener('click', togglePause);
    byId('btn-copy').addEventListener('click', copyConsole);
    byId('btn-preset-ha').addEventListener('click', applyHAPreset);
    byId('btn-baseid-read').addEventListener('click', doReadBaseId);
    byId('btn-baseid-write').addEventListener('click', doWriteBaseId);

    void initEo();

    // Telegramm-Filter (Absender/Name/RORG/...).
    const telFilterEl = byId<HTMLInputElement>('tel_filter');
    telFilterEl.addEventListener('input', () => {
        telFilter = telFilterEl.value.trim().toLowerCase();
        applyTelegramFilter();
    });
    // Klick auf eine Telegramm-Zeile -> ESP3-Rohframe feldweise ein-/ausklappen.
    byId('tel_body').addEventListener('click', (e) => {
        const row = (e.target as HTMLElement).closest('tr.tel-row') as HTMLTableRowElement | null;
        if (!row) return;
        const nx = row.nextElementSibling;
        if (nx && nx.classList.contains('tel-detail')) {
            nx.remove();
            return;
        }
        const frame = row.getAttribute('data-frame');
        if (!frame) return;
        row.after(buildTelDetail(frame));
    });

    wireConsoleKeyboard();
    populateTz();

    void loadState();
    void doScan();
    setInterval(pollClients, 3000);
    setInterval(pollStats, 3000);
    setInterval(pollConsole, 1000);
    setInterval(pollEvents, 2000);
    void pollClients();
    void pollStats();
    void pollConsole();
    void pollEvents();
}

init();
