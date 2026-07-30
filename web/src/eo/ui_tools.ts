// Reiter "Werkzeuge": Telegramm senden, EEP-Prüfer, PCT14, Gerätekatalog,
// Datenbestand sichern/laden.
//
// Portierung von eo_man/view/send_message_window.py, eep_checker_window.py,
// device_info_window.py und den PCT14-Menüpunkten aus menu_presenter.py.

import { DEVICE_CATALOG } from './catalog';
import { LOCAL_SENDER_OFFSET_ID } from './ha_config';
import { decodeEepValues, eepClass, eepNames, eepTitle } from './eep_decode';
import { byId, downloadText, escapeHtml, optionList, pickTextFile } from './dom';
import { eoApp } from './app';
import { mergeDevice, migrateDocument } from './model';
import { extendPct14Export, importPct14 } from './pct14';
import {
    TELEGRAM_TYPES,
    buildEsp3Radio,
    parseAddressBytes,
    parseEsp3Radio,
    parseHexString,
    splitFrame,
    telegramTypeOf,
    toHexString,
    type TelegramType,
} from './telegram';

// -----------------------------------------------------------------------------
// Telegramm senden
// -----------------------------------------------------------------------------

const SEG_COLORS: Record<string, string> = {
    frame: 'var(--hint)',
    crc: 'var(--hint)',
    org: '#c47f00',
    data: 'var(--danger)',
    address: '#1a7f37',
    status: '#0057b7',
    optional: 'var(--hint)',
};

/** Läuft ein Dauer-Sendevorgang? Wird vom Stop-Knopf zurückgesetzt. */
let repeatRemaining = 0;

function currentType(): TelegramType {
    return (byId<HTMLSelectElement>('tg_type')?.value as TelegramType) || '4BS';
}

function currentFrame(): number[] | null {
    const type = currentType();
    const spec = TELEGRAM_TYPES[type];

    const data = parseHexString(byId<HTMLInputElement>('tg_data')?.value || '');
    if (data.length < spec.dataLen) return null;

    const sender = byId<HTMLInputElement>('tg_sender')?.value || '';
    if (parseHexString(sender).length !== 4) return null;

    const status = parseHexString(byId<HTMLInputElement>('tg_status')?.value || '00');
    return buildEsp3Radio({
        type,
        data: data.slice(0, spec.dataLen),
        senderId: parseAddressBytes(sender),
        status: status[0] ?? 0,
    });
}

function renderFrame(): void {
    const box = byId('tg_frame');
    if (!box) return;

    const frame = currentFrame();
    if (!frame) {
        box.innerHTML = '<span style="color:var(--danger)">Eingabe unvollständig oder ungültig</span>';
        return;
    }
    box.innerHTML = splitFrame(frame)
        .map(
            (s) =>
                `<span title="${escapeHtml(s.label)}" style="color:${SEG_COLORS[s.kind]}">${escapeHtml(s.hex)}</span>`,
        )
        .join(' ');

    const hint = byId('tg_len');
    if (hint) hint.textContent = `${frame.length} Byte`;
}

async function sendFrameOnce(frame: number[]): Promise<boolean> {
    const token = eoApp.ctx.apiToken();
    if (!token) {
        eoApp.ctx.say('Senden braucht die REST-API — im Reiter API aktivieren');
        return false;
    }
    try {
        const res = await fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ hex: toHexString(frame) }),
        });
        if (!res.ok) {
            eoApp.ctx.say(`Senden fehlgeschlagen (HTTP ${res.status})`);
            return false;
        }
        return true;
    } catch (e) {
        eoApp.ctx.say(`Senden fehlgeschlagen: ${String(e)}`);
        return false;
    }
}

function setSendButtonState(): void {
    const btn = byId<HTMLButtonElement>('tg_send');
    if (btn) btn.textContent = repeatRemaining !== 0 ? 'Stopp' : 'Senden';
}

async function onSend(): Promise<void> {
    if (repeatRemaining !== 0) {
        repeatRemaining = 0;
        setSendButtonState();
        return;
    }
    const frame = currentFrame();
    if (!frame) { eoApp.ctx.say('Telegramm ungültig'); return; }

    const repeat = byId<HTMLInputElement>('tg_repeat')?.checked ?? false;
    if (!repeat) {
        if (await sendFrameOnce(frame)) eoApp.ctx.say('Telegramm gesendet');
        return;
    }

    const delay = Math.max(10, parseInt(byId<HTMLInputElement>('tg_delay')?.value || '100', 10) || 100);
    const count = parseInt(byId<HTMLInputElement>('tg_count')?.value || '', 10);
    // -1 = endlos (wie im Desktop-Tool); der Knopf wird dann zum Stopp-Knopf.
    // Leeres oder unlesbares Feld heisst EIN Telegramm, nicht "endlos" - ein
    // versehentlicher Dauersender waere die unangenehmere Fehlbedienung.
    repeatRemaining = Number.isFinite(count) ? count : 1;
    setSendButtonState();

    let sent = 0;
    while (repeatRemaining !== 0) {
        if (repeatRemaining > 0) repeatRemaining--;
        if (!(await sendFrameOnce(frame))) break;
        sent++;
        await new Promise((r) => setTimeout(r, delay));
    }
    repeatRemaining = 0;
    setSendButtonState();
    eoApp.ctx.say(`${sent} Telegramm(e) gesendet`);
}

function renderTemplates(): void {
    const box = byId('tg_favs');
    if (!box) return;
    if (!eoApp.doc.templates.length) {
        box.innerHTML = '<div class="hint">keine Vorlagen gespeichert</div>';
        return;
    }
    box.innerHTML = eoApp.doc.templates
        .map((t, i) => {
            const parsed = parseEsp3Radio(parseHexString(t.hex));
            const desc = parsed
                ? `${telegramTypeOf(parsed.rorg) || '??'} · Daten ${toHexString(parsed.payload, ' ')} · ` +
                  `Sender ${toHexString(parsed.sender, '-')} · Status ${toHexString([parsed.status])}`
                : t.hex;
            return (
                `<div class="row" style="align-items:flex-start">` +
                `<div style="flex:1"><b>${escapeHtml(t.name || '(ohne Namen)')}</b>` +
                `<div class="hint" style="font-family:ui-monospace,monospace">${escapeHtml(desc)}</div></div>` +
                `<button type="button" class="ghost" data-fav-apply="${i}">Übernehmen</button>` +
                `<button type="button" class="ghost" data-fav-del="${i}">Entfernen</button></div>`
            );
        })
        .join('');
}

function applyTemplate(index: number): void {
    const t = eoApp.doc.templates[index];
    if (!t) return;
    const parsed = parseEsp3Radio(parseHexString(t.hex));
    if (!parsed) { eoApp.ctx.say('Vorlage nicht lesbar'); return; }

    const type = telegramTypeOf(parsed.rorg);
    if (type) {
        const sel = byId<HTMLSelectElement>('tg_type');
        if (sel) sel.value = type;
    }
    setValue('tg_data', toHexString(parsed.payload, ' '));
    setValue('tg_sender', toHexString(parsed.sender, '-'));
    setValue('tg_status', toHexString([parsed.status]));
    renderFrame();
}

function setValue(id: string, value: string): void {
    const el = byId<HTMLInputElement>(id);
    if (el) el.value = value;
}

function initSender(): void {
    const typeSel = byId<HTMLSelectElement>('tg_type');
    if (typeSel) {
        typeSel.innerHTML = Object.entries(TELEGRAM_TYPES)
            .map(([name, spec]) => `<option value="${name}"${name === '4BS' ? ' selected' : ''}>${name} (${spec.org})</option>`)
            .join('');
    }

    for (const id of ['tg_data', 'tg_sender', 'tg_status']) {
        byId(id)?.addEventListener('input', renderFrame);
    }
    typeSel?.addEventListener('change', () => {
        // Bei RPS/1BS ist nur ein Datenbyte erlaubt - Rest wegwerfen, damit die
        // Vorschau nicht dauerhaft "ungültig" zeigt.
        const spec = TELEGRAM_TYPES[currentType()];
        const el = byId<HTMLInputElement>('tg_data');
        if (el) {
            const bytes = parseHexString(el.value).slice(0, spec.dataLen);
            while (bytes.length < spec.dataLen) bytes.push(0);
            el.value = toHexString(bytes, ' ');
        }
        renderFrame();
    });

    byId('tg_send')?.addEventListener('click', () => void onSend());

    byId('tg_fav_add')?.addEventListener('click', () => {
        const frame = currentFrame();
        if (!frame) { eoApp.ctx.say('Telegramm ungültig'); return; }
        const name = (byId<HTMLInputElement>('tg_fav_name')?.value || '').trim();
        eoApp.doc.templates.push({ name, hex: toHexString(frame) });
        setValue('tg_fav_name', '');
        eoApp.touch();
        renderTemplates();
    });

    byId('tg_favs')?.addEventListener('click', (e) => {
        const el = e.target as HTMLElement;
        const apply = el.getAttribute('data-fav-apply');
        if (apply !== null) { applyTemplate(parseInt(apply, 10)); return; }
        const del = el.getAttribute('data-fav-del');
        if (del !== null) {
            eoApp.doc.templates.splice(parseInt(del, 10), 1);
            eoApp.touch();
            renderTemplates();
        }
    });

    // Sender-ID mit der Base-ID des eigenen TCM515 vorbelegen - alles andere
    // wird vom Empfänger ohnehin ignoriert.
    const sender = byId<HTMLInputElement>('tg_sender');
    if (sender && !sender.value) sender.value = eoApp.doc.baseId || '00-00-00-00';

    renderTemplates();
    renderFrame();
}

// -----------------------------------------------------------------------------
// EEP-Prüfer
// -----------------------------------------------------------------------------

function renderEepCheck(): void {
    const out = byId('eep_out');
    if (!out) return;

    const eep = byId<HTMLSelectElement>('eep_sel')?.value || '';
    const data = parseHexString(byId<HTMLInputElement>('eep_data')?.value || '');

    const cls = byId('eep_cls');
    if (cls) cls.textContent = eep ? `${eepClass(eep) || '?'} · ${eepTitle(eep) || 'keine Beschreibung'}` : '';

    if (!eep) { out.innerHTML = '<div class="hint">EEP wählen</div>'; return; }
    const values = decodeEepValues(eep, data);
    if (!values.length) {
        out.innerHTML =
            '<div class="hint">Für dieses Profil sind keine linearen Felder hinterlegt ' +
            '(viele VLD-Profile) oder die Datenbytes reichen nicht.</div>';
        return;
    }
    out.innerHTML =
        '<table><thead><tr><th>Größe</th><th>Wert</th></tr></thead><tbody>' +
        values
            .map(
                (v) =>
                    `<tr><td>${escapeHtml(v.label)}</td>` +
                    `<td>${escapeHtml(v.value)}${v.unit ? ' ' + escapeHtml(v.unit) : ''}</td></tr>`,
            )
            .join('') +
        '</tbody></table>';
}

function initEepChecker(): void {
    const sel = byId<HTMLSelectElement>('eep_sel');
    if (sel) sel.innerHTML = optionList(eepNames(), 'A5-08-01', '— EEP wählen —');
    setValue('eep_data', 'AA 80 76 0F');
    byId('eep_sel')?.addEventListener('change', renderEepCheck);
    byId('eep_data')?.addEventListener('input', renderEepCheck);
    renderEepCheck();
}

// -----------------------------------------------------------------------------
// PCT14
// -----------------------------------------------------------------------------

function pct14Log(html: string): void {
    const box = byId('pct14_log');
    if (box) box.innerHTML = html;
}

function warningsHtml(warnings: string[], limit = 20): string {
    if (!warnings.length) return '';
    const shown = warnings.slice(0, limit);
    return (
        '<div class="hint"><b>Hinweise:</b><ul style="margin:6px 0 0 18px">' +
        shown.map((w) => `<li>${escapeHtml(w)}</li>`).join('') +
        (warnings.length > shown.length ? `<li>… ${warnings.length - shown.length} weitere</li>` : '') +
        '</ul></div>'
    );
}

async function onPct14Import(): Promise<void> {
    const file = await pickTextFile('.xml,text/xml,application/xml');
    if (!file) return;
    try {
        const res = importPct14(file.text);
        let added = 0;
        let merged = 0;
        for (const d of res.devices) {
            const existing = eoApp.doc.devices[d.externalId];
            if (existing) { mergeDevice(existing, d); merged++; }
            else { eoApp.doc.devices[d.externalId] = d; added++; }
        }
        if (res.baseId && !eoApp.doc.baseId) eoApp.doc.baseId = res.baseId;
        eoApp.touch();
        pct14Log(
            `<div>Import aus <b>${escapeHtml(file.name)}</b>: ${added} neu, ${merged} aktualisiert ` +
                `(Base-ID ${escapeHtml(res.baseId)}).</div>` + warningsHtml(res.warnings),
        );
        eoApp.ctx.say(`PCT14-Import: ${added + merged} Geräte`);
    } catch (e) {
        pct14Log(`<div style="color:var(--danger)">Import fehlgeschlagen: ${escapeHtml(String(e))}</div>`);
    }
}

async function onPct14Extend(): Promise<void> {
    const file = await pickTextFile('.xml,text/xml,application/xml');
    if (!file) return;
    try {
        const res = extendPct14Export(file.text, eoApp.doc, LOCAL_SENDER_OFFSET_ID);
        if (!res.added) {
            pct14Log(
                '<div>Keine Sender-ID ergänzt — entweder sind alle bereits eingetragen oder ' +
                    'den Geräten fehlt ein Sender.</div>' + warningsHtml(res.warnings),
            );
            return;
        }
        downloadText(file.name.replace(/\.xml$/i, '') + '_mit_HA_Sendern.xml', res.xml, 'application/xml');
        pct14Log(
            `<div>${res.added} Sender-ID(s) ergänzt — Datei wurde heruntergeladen. ` +
                'In PCT14 einlesen und auf die Aktoren schreiben.</div>' + warningsHtml(res.warnings),
        );
    } catch (e) {
        pct14Log(`<div style="color:var(--danger)">Fehlgeschlagen: ${escapeHtml(String(e))}</div>`);
    }
}

// -----------------------------------------------------------------------------
// Gerätekatalog
// -----------------------------------------------------------------------------

function renderCatalog(): void {
    const body = byId('cat_body');
    if (!body) return;
    const term = (byId<HTMLInputElement>('cat_search')?.value || '').trim().toUpperCase();

    const rows = DEVICE_CATALOG.filter(
        (e) =>
            !term ||
            e.hw.toUpperCase().includes(term) ||
            (e.eep || '').toUpperCase().includes(term) ||
            (e.desc || '').toUpperCase().includes(term) ||
            (e.platform || '').toUpperCase().includes(term),
    );

    body.innerHTML = rows.length
        ? rows
              .map(
                  (e) =>
                      `<tr><td data-label="Typ">${escapeHtml(e.hw)}</td>` +
                      `<td data-label="Hersteller">${escapeHtml(e.brand || '')}</td>` +
                      `<td data-label="EEP">${escapeHtml(e.eep || '')}</td>` +
                      `<td data-label="Sender-EEP">${escapeHtml(e.senderEep || '')}</td>` +
                      `<td data-label="Plattform">${escapeHtml(e.platform || '')}</td>` +
                      `<td data-label="Kanäle">${e.channels || 1}</td>` +
                      `<td data-label="PCT14">${e.pct14Fg !== undefined ? `FG ${e.pct14Fg} / F ${e.pct14Kf}` : ''}</td>` +
                      `<td data-label="Beschreibung">${escapeHtml(e.desc || '')}</td></tr>`,
              )
              .join('')
        : '<tr><td colspan="8" class="hint">kein Treffer</td></tr>';

    const count = byId('cat_count');
    if (count) count.textContent = `${rows.length} von ${DEVICE_CATALOG.length}`;
}

// -----------------------------------------------------------------------------
// Datenbestand sichern / laden
// -----------------------------------------------------------------------------

function onBackup(): void {
    downloadText(
        `eul-geraete-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(eoApp.doc, null, 2),
        'application/json;charset=utf-8',
    );
}

async function onRestore(): Promise<void> {
    const file = await pickTextFile('.json,application/json');
    if (!file) return;
    if (!confirm('Der aktuelle Bestand wird durch die Datei ersetzt. Fortfahren?')) return;
    try {
        eoApp.doc = migrateDocument(JSON.parse(file.text));
        eoApp.touch();
        await eoApp.store?.flush();
        eoApp.ctx.say(`Bestand aus ${file.name} geladen`);
    } catch (e) {
        eoApp.ctx.say(`Laden fehlgeschlagen: ${String(e)}`);
    }
}

// -----------------------------------------------------------------------------

export function initToolsTab(): void {
    initSender();
    initEepChecker();

    byId('pct14_import')?.addEventListener('click', () => void onPct14Import());
    byId('pct14_extend')?.addEventListener('click', () => void onPct14Extend());

    byId('cat_search')?.addEventListener('input', renderCatalog);
    renderCatalog();

    byId('eo_backup')?.addEventListener('click', onBackup);
    byId('eo_restore')?.addEventListener('click', () => void onRestore());

    eoApp.onDevicesChanged(renderTemplates);
}

/** Wird vom Statuspolling gefüttert, damit der Speicherstand aktuell bleibt. */
export function updateStorageInfo(fsTotal: number, fsUsed: number, docBytes: number): void {
    const el = byId('eo_storage');
    if (!el) return;
    if (!fsTotal) {
        el.textContent = 'Gerätespeicher nicht verfügbar — der Bestand wird nicht dauerhaft gesichert.';
        return;
    }
    const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
    el.textContent =
        `Datenbestand auf dem Gerät: ${kb(docBytes)} · Dateisystem ${kb(fsUsed)} von ${kb(fsTotal)} belegt ` +
        `(${Object.keys(eoApp.doc.devices).length} Geräte).`;
}
