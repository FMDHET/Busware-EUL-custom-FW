// Erzeugt die README-Screenshots aus dem echten Portal-Code.
//
// Statt das Portal auf einem Geraet zu fotografieren (braucht Hardware,
// Zugangsdaten und einen bestimmten Datenbestand) wird hier web/index.html mit
// dem gebauten Bundle lokal ausgeliefert und mit Demo-Antworten auf /api/*
// gefuettert. Gerendert wird also die echte Oberflaeche - nur die Daten sind
// gestellt.
//
// Aufruf (aus dem Repo-Wurzelverzeichnis):
//   node web/build.mjs && node scripts/screenshot_portal.mjs
//
// Braucht Google Chrome. Ergebnis: docs/screenshots/*.png

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'docs', 'screenshots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8731;
const HOST = 'eul-gateway-d3a768.local';

// -----------------------------------------------------------------------------
// Demo-Daten
// -----------------------------------------------------------------------------

const BASE_ID = 'FF-DB-60-80';

/** Ein ESP3-RADIO_ERP1-Frame als Konsolenzeile, wie sie das Geraet schreibt. */
function rxLine(hexBytes) {
    return '< TCM                   : ' + hexBytes.join(' ') + ` (${hexBytes.length}B)`;
}
function txLine(peer, hexBytes) {
    return `> ${peer.padEnd(21)} : ` + hexBytes.join(' ') + ` (${hexBytes.length}B)`;
}

// CRC8 (Polynom 0x07), damit die Demo-Frames auch wirklich gueltig sind.
const CRC = (() => {
    const t = [];
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
        t.push(c);
    }
    return (bytes) => bytes.reduce((c, b) => t[(c ^ b) & 0xff], 0);
})();

function radio(rorg, data, sender, status, dbm) {
    const payload = [rorg, ...data, ...sender, status];
    const opt = [0x03, 0xff, 0xff, 0xff, 0xff, dbm, 0x00];
    const head = [(payload.length >> 8) & 0xff, payload.length & 0xff, opt.length, 0x01];
    const frame = [0x55, ...head, CRC(head), ...payload, ...opt, CRC([...payload, ...opt])];
    return frame.map((b) => b.toString(16).padStart(2, '0'));
}

const TELEGRAMS = [
    // Taster: Wippe A oben gedrueckt / losgelassen
    rxLine(radio(0xf6, [0x30], [0x05, 0x14, 0x75, 0x0a], 0x30, 58)),
    rxLine(radio(0xf6, [0x00], [0x05, 0x14, 0x75, 0x0a], 0x20, 61)),
    // Temperatur-/Feuchtesensor A5-04-02
    rxLine(radio(0xa5, [0x00, 0x7d, 0x64, 0x0a], [0x01, 0x9b, 0x2c, 0x41], 0x00, 72)),
    // Fensterkontakt 1BS
    rxLine(radio(0xd5, [0x09], [0x01, 0x9b, 0x30, 0x12], 0x00, 66)),
    // Licht-/Anwesenheitssensor A5-08-01
    rxLine(radio(0xa5, [0xaa, 0x80, 0x76, 0x0f], [0x01, 0x9b, 0x44, 0x07], 0x00, 81)),
    // Zentralkommando an einen Aktor (gesendet)
    txLine('192.168.177.42:51044', radio(0xa5, [0x01, 0x00, 0x00, 0x09], [0xff, 0xdb, 0x60, 0x82], 0x00, 255)),
    // Rueckmeldung des Aktors (M5-38-08, RPS)
    rxLine(radio(0xf6, [0x70], [0x05, 0x15, 0x0e, 0x39], 0x30, 55)),
];

const CONSOLE_LINES = TELEGRAMS.map((line, i) => ({ seq: i + 1, ms: 41000 + i * 1300, line }));

function device(o) {
    return {
        address: o.id, externalId: o.id, baseId: '00-00-00-00', busDevice: false,
        channel: 1, devSize: 1, version: '', keyFunction: '', memory: [],
        rorg: o.rorg ?? 0, telegrams: o.telegrams ?? 12,
        lastSeen: Date.parse('2026-07-30T13:42:11'), rssi: o.rssi ?? -64,
        deviceType: o.type ?? '', name: o.name, comment: o.comment ?? '',
        eep: o.eep ?? '', haPlatform: o.platform ?? '', useInHa: o.ha ?? true,
        additional: o.additional ?? {},
    };
}

const EO_DOC = {
    version: 1,
    baseId: BASE_ID,
    selectedFilter: null,
    filters: {
        Erdgeschoss: { name: 'Erdgeschoss', global: ['EG'], address: [], externalAddress: [], deviceType: [], eep: [] },
    },
    templates: [
        { name: 'Licht ein (Zentralkommando)', hex: radio(0xa5, [0x01, 0x00, 0x00, 0x09], [0xff, 0xdb, 0x60, 0x82], 0x00, 255).join('').toUpperCase() },
    ],
    devices: Object.fromEntries([
        device({ id: '05-14-75-0A', name: 'Aktuator OG', type: 'FSR61-230V', eep: 'M5-38-08',
                 platform: 'light', comment: 'Relay', rorg: 0xf6, rssi: -58,
                 additional: { sender: { id: '02', eep: 'A5-38-08' }, fast_status_change: 'true' } }),
        device({ id: '05-15-0E-39', name: 'Aktuator EG', type: 'FSR61-230V', eep: 'M5-38-08',
                 platform: 'light', comment: 'Relay', rorg: 0xf6, rssi: -55,
                 additional: { sender: { id: '01', eep: 'A5-38-08' }, fast_status_change: 'true' } }),
        device({ id: '01-9B-2C-41', name: 'Temperatur Wohnzimmer', type: 'FLT58', eep: 'A5-04-02',
                 platform: 'sensor', comment: 'Temperature and Humidity Sensor', rorg: 0xa5, rssi: -72 }),
        device({ id: '01-9B-30-12', name: 'Fenster Küche', type: 'FTKE', eep: 'F6-10-00',
                 platform: 'binary_sensor', comment: 'window and door contacts', rorg: 0xd5, rssi: -66 }),
        device({ id: '01-9B-44-07', name: 'Bewegung Flur', type: 'FBH65', eep: 'A5-08-01',
                 platform: 'sensor', comment: 'Light-, Temperature-, Occupancy Sensor', rorg: 0xa5, rssi: -81 }),
        device({ id: '05-2A-11-C3', name: 'Rollladen Bad', type: 'FSB61-230V', eep: 'G5-3F-7F',
                 platform: 'cover', comment: 'Cover', rorg: 0xf6, rssi: -69,
                 additional: { sender: { id: '03', eep: 'H5-3F-7F' }, device_class: 'shutter', time_closes: 25, time_opens: 25 } }),
        device({ id: '01-A2-77-5E', name: 'Taster Flur', type: 'F4T55E', eep: 'F6-02-01',
                 platform: 'binary_sensor', comment: 'Wireless 4-way pushbutton', rorg: 0xf6, rssi: -60 }),
    ].map((d) => [d.externalId, d])),
};

const API = {
    '/api/state': {
        mode: 'normal', suffix: 'D3A768', wifi_ssid: 'Heimnetz', wifi_pass: '',
        usb_enabled: false, tcp_enabled: true, tcp_port: 5100, tcp_auth_required: false,
        tcp_token: '00000000000000000000000000000000', ota_token: '00000000000000000000000000000000',
        admin_pass: '', api_enabled: true, device_name: 'EUL-Custom', admin_user: 'admin',
        ntp_server: 'pool.ntp.org', tz: 'CET-1CEST,M3.5.0,M10.5.0/3',
        fw_version: '1.1.0', fw_build: 7, fw_git: '34e40e9',
        fw_date: '2026-07-30 13:13', fw_part: 'ota_1',
    },
    '/api/stats': {
        clients: 1, tcm_rx_bytes: 184320, tcm_tx_bytes: 5120,
        tcm_rx_frames: 6144, tcm_tx_frames: 208, ip: '192.168.177.15', rssi: -54,
        uptime_ms: 9_412_000, epoch_ms: Date.parse('2026-07-30T13:42:11'),
        fs_total: 950272, fs_used: 12288, eo_bytes: 4180,
        heap_free: 148_512, heap_max: 92_160,
    },
    '/api/clients': [
        { peer: '192.168.177.42:51044', connected_ms: 3_180_000, rx_bytes: 4096,
          tx_bytes: 122_880, rx_frames: 164, tx_dropped: 0 },
    ],
    '/api/scan': [
        { ssid: 'Heimnetz', rssi: -54, auth: 'WPA2' },
        { ssid: 'Heimnetz-Gast', rssi: -61, auth: 'WPA2' },
    ],
    '/api/baseid': { base_id: BASE_ID, writes_remaining: 7 },
    '/api/console': { lines: CONSOLE_LINES, last_seq: CONSOLE_LINES.length },
    '/api/events': {
        events: [
            { seq: 4, ms: 9_400_000, ts: Date.parse('2026-07-30T13:42:02'), lvl: 0, tag: 'net', msg: 'status rssi=-54 dBm ip=192.168.177.15 clients=1 heap=148512' },
            { seq: 3, ms: 41_000, ts: Date.parse('2026-07-30T11:05:31'), lvl: 0, tag: 'tcp', msg: 'Client 192.168.177.42:51044 verbunden' },
            { seq: 2, ms: 8_200, ts: Date.parse('2026-07-30T11:05:24'), lvl: 0, tag: 'wifi', msg: 'verbunden, IP 192.168.177.15 (rssi -54 dBm)' },
            { seq: 1, ms: 900, ts: Date.parse('2026-07-30T11:05:16'), lvl: 0, tag: 'boot', msg: 'Busware EUL v1.1.0 build 7 (34e40e9) gestartet' },
        ],
        last_seq: 4,
    },
    '/api/eo': EO_DOC,
};

// -----------------------------------------------------------------------------
// Ein kleiner Treiber, der die Ansicht fuer den jeweiligen Screenshot herrichtet
// (Zeile aufklappen, Geraet auswaehlen, YAML erzeugen). Chrome kann per
// Kommandozeile nicht klicken, deshalb wird das Skript in die Seite injiziert.
// -----------------------------------------------------------------------------
const DRIVERS = {
    status: `
        const row = document.querySelector('#tel_body tr.tel-row:nth-child(3)');
        if (row) row.click();`,
    geraete: `
        const row = document.querySelector('#eo_tbody tr[data-id="05-14-75-0A"]');
        if (row) row.click();`,
    ha: `document.getElementById('ha_generate')?.click();`,
    werkzeuge: '',
    pct14: `document.getElementById('cat_search').value = 'FSR';
            document.getElementById('cat_search').dispatchEvent(new Event('input'));`,
};

function pageFor(tab) {
    let html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const bundle = fs.readFileSync(path.join(ROOT, 'main', 'portal_html.h'), 'utf8');
    // Das gebaute Bundle steckt bereits in portal_html.h - wir holen es dort
    // heraus, damit garantiert derselbe Code laeuft wie auf dem Geraet.
    const js = bundle
        .split('\n')
        .filter((l) => l.startsWith('"'))
        .map((l) => l.slice(1, -1).replace(/\\n$/, ''))
        .join('\n')
        .replace(/\\"/g, '"')
        .replace(/\\\?/g, '?')
        .replace(/\\\\/g, '\\');
    const start = js.indexOf('<script>');
    const end = js.lastIndexOf('</script>');
    html = html.replace('<!--SCRIPT-->', js.slice(start, end + 9));

    // Nach dem Herrichten der Ansicht ALLE Timer stoppen. Das Portal pollt
    // /api/console & Co. im Sekundentakt weiter; solange das laeuft, wird die
    // Seite nie ruhig und Chrome loest den Screenshot nie aus (es wartet auf
    // Leerlauf, --virtual-time-budget hin oder her).
    return html.replace(
        '</body>',
        `<script>
           window.addEventListener('load', () => setTimeout(() => {
             try { ${DRIVERS[tab] || ''} } catch (e) { console.error(e); }
             const last = setInterval(() => {}, 100000);
             for (let i = 1; i <= last; i++) { clearInterval(i); clearTimeout(i); }
             document.title = 'ready';
           }, 1500));
         </script></body>`,
    );
}

// -----------------------------------------------------------------------------

const SHOTS = [
    ['status', 'Status: Live-Telegramme mit farbcodiertem ESP3-Rohframe', 1340, 1080],
    ['geraete', 'Geräte: Inventar, Filter und Detailformular', 1340, 1680],
    ['ha', 'Home Assistant: erzeugte configuration.yaml', 1340, 1180],
    ['werkzeuge', 'Werkzeuge: Telegramm senden und EEP-Prüfer', 1340, 920],
    ['pct14', 'PCT14: Import/Export, Gerätekatalog, Sicherung', 1340, 1000],
];

const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
        // /api/console liefert nur NEUE Zeilen. Ohne das haengt jeder Poll
        // dieselben Telegramme erneut an und die Tabelle zeigt sie doppelt.
        if (url.pathname === '/api/console') {
            const since = Number(url.searchParams.get('since') || 0);
            const lines = CONSOLE_LINES.filter((l) => l.seq > since);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ lines, last_seq: CONSOLE_LINES.length }));
            return;
        }
        const body = API[url.pathname];
        res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body ?? { error: 'not found' }));
        return;
    }
    const tab = url.searchParams.get('tab') || 'status';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageFor(tab));
});

// -----------------------------------------------------------------------------
// Chrome ueber das DevTools-Protokoll steuern.
//
// Chromes --screenshot-Schalter wartet auf Leerlauf der Seite. Das Portal
// pollt dauerhaft, wird also nie leer - der Aufruf haengt endlos. Ueber CDP
// bestimmen wir selbst, wann geladen, gefuellt und aufgenommen wird.
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpConnect(port) {
    // Chrome braucht einen Moment, bis der Debug-Port offen ist.
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = list.find((t) => t.type === 'page');
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* noch nicht bereit */ }
        await sleep(250);
    }
    throw new Error('Chrome-Debug-Port nicht erreichbar');
}

function cdpSession(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    const ready = new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', rej, { once: true });
    });
    ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    });
    return {
        ready,
        send(method, params = {}) {
            const n = ++id;
            ws.send(JSON.stringify({ id: n, method, params }));
            return new Promise((res, rej) => pending.set(n, { res, rej }));
        },
        close: () => ws.close(),
    };
}

async function run() {
    fs.mkdirSync(OUT, { recursive: true });
    const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'eul-shot-'));
    const chrome = spawn(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=9333',
        `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
        `--user-data-dir=${profile}`,
        'about:blank',
    ], { stdio: 'ignore' });

    try {
        const s = cdpSession(await cdpConnect(9333));
        await s.ready;
        await s.send('Page.enable');

        for (const [tab, title, w, h] of SHOTS) {
            // Bei device-scale 2 wird das PNG doppelt so gross - gut lesbar
            // auf Retina-Displays und in GitHubs Zoom.
            await s.send('Emulation.setDeviceMetricsOverride', {
                width: w, height: h, deviceScaleFactor: 2, mobile: false,
            });
            await s.send('Page.navigate', { url: `http://${HOST}:${PORT}/?tab=${tab}#${tab}` });
            // Der Treiber im Dokument setzt den Titel auf 'ready', sobald die
            // Ansicht steht. Darauf warten statt blind zu pausieren.
            for (let i = 0; i < 80; i++) {
                const { result } = await s.send('Runtime.evaluate', { expression: 'document.title' });
                if (result.value === 'ready') break;
                await sleep(100);
            }
            await sleep(300);   // letzte Layout-/Font-Runde

            const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
            const file = path.join(OUT, `${tab}.png`);
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
            const kb = (fs.statSync(file).size / 1024).toFixed(0);
            console.log(`[shot] ${path.relative(ROOT, file)}  ${kb} KB  - ${title}`);
        }
        s.close();
    } finally {
        chrome.kill('SIGKILL');
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* egal */ }
        server.close();
    }
}

server.listen(PORT, '127.0.0.1', () => {
    run().catch((e) => {
        console.error('Fehlgeschlagen:', e.message);
        process.exitCode = 1;
        server.close();
    });
});
