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
type TabName = 'wifi' | 'usb' | 'enocean' | 'konsole';

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

async function doSave(): Promise<void> {
    const body: SaveBody = {
        tcp_enabled: byId<HTMLInputElement>('tcp_en').checked,
        tcp_port: parseInt(byId<HTMLInputElement>('tcp_port').value, 10) || 5100,
        tcp_auth_required: byId<HTMLInputElement>('tcp_auth').checked,
        usb_enabled: byId<HTMLInputElement>('usb_en').checked,
    };
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

async function pollStats(): Promise<void> {
    try {
        const s = await api.stats();
        byId('stats').textContent =
            `aktive Clients : ${s.clients}\n` +
            `RX vom TCM515  : ${fmtBytes(s.tcm_rx_bytes)} / ${s.tcm_rx_frames} Frames\n` +
            `TX an TCM515   : ${fmtBytes(s.tcm_tx_bytes)} / ${s.tcm_tx_frames} Frames`;
    } catch {
        // silent
    }
}

let conSeq = 0;
let conPaused = false;

async function pollConsole(): Promise<void> {
    if (conPaused) return;
    try {
        const j = await api.console(conSeq);
        if (!j.lines.length) return;
        const el = byId<HTMLPreElement>('con');
        const chunk = j.lines
            .map((l) => {
                const t = (l.ms / 1000).toFixed(3).padStart(9, ' ');
                return `[${t}] ${l.line}`;
            })
            .join('\n');
        el.textContent = el.textContent ? el.textContent + '\n' + chunk : chunk;
        conSeq = j.last_seq;
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
    byId('con').textContent = '';
    conSeq = 0;
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

    byId('btn-scan').addEventListener('click', doScan);
    byId('btn-regen').addEventListener('click', doRegenToken);
    byId('btn-save').addEventListener('click', doSave);
    byId('btn-factory').addEventListener('click', doFactoryReset);
    byId('btn-clear').addEventListener('click', clearConsole);
    byId('btn-pause').addEventListener('click', togglePause);
    byId('btn-copy').addEventListener('click', copyConsole);
    byId('btn-preset-ha').addEventListener('click', applyHAPreset);

    wireConsoleKeyboard();

    void loadState();
    void doScan();
    setInterval(pollClients, 2000);
    setInterval(pollStats, 2000);
    setInterval(pollConsole, 500);
    void pollClients();
    void pollStats();
    void pollConsole();
}

init();
