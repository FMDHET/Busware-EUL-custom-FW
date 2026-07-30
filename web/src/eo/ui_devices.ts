// Reiter "Geräte": Filterleiste, Geräteliste, Detailformular.
//
// Portierung von eo_man/view/filter_bar.py, device_table.py und
// device_details.py in eine einzelne, tabellenbasierte Ansicht. Die
// Baumdarstellung des Desktop-Tools (Gateway -> Bus-Geräte) entfaellt: am EUL
// sind praktisch alle Geräte dezentral, ein Baum mit einem Ast hilft niemand.

import {
    ELTAKO_DEVICES,
    HA_PLATFORMS,
    KEY_FUNCTION_NAMES,
    eepFromKeyFunctionName,
    eltakoModelsFor,
    findByDeviceType,
    formatRssi,
    keyFunctionName,
    knownDeviceTypes,
} from './catalog';
import { eepClass, eepNames, eepTitle } from './eep_decode';
import { deviceMatchesFilter, isEmptyFilter, splitTerms } from './filter';
import { byId, escapeHtml, fmtClock, optionList } from './dom';
import { eoApp } from './app';
import { MultiSelect } from './multiselect';
import { relatedDevices, newDevice, type AddField, type EoDevice, type EoFilter } from './model';
import { suggestHaConfig } from './suggest';

type SortKey =
    | 'name' | 'address' | 'externalId' | 'deviceType' | 'keyFunction'
    | 'eep' | 'haPlatform' | 'useInHa' | 'rssi' | 'lastSeen';

let sortKey: SortKey = 'externalId';
let sortAsc = true;
let selectedId: string | null = null;
/** Nur-HA-Zusatzfilter der Filterleiste (nicht Teil gespeicherter Filter). */
let onlyHa = false;

// -----------------------------------------------------------------------------
// Filterleiste
// -----------------------------------------------------------------------------

/** Klapplisten fuer Gerätetyp und EEP (erst in initFilterBar erzeugt). */
let typeSelect: MultiSelect | null = null;
let eepSelect: MultiSelect | null = null;

function currentFilter(): EoFilter {
    return {
        name: byId<HTMLInputElement>('eo_f_name')?.value.trim() || '',
        global: splitTerms(byId<HTMLInputElement>('eo_f_global')?.value || ''),
        address: splitTerms(byId<HTMLInputElement>('eo_f_addr')?.value || ''),
        externalAddress: splitTerms(byId<HTMLInputElement>('eo_f_ext')?.value || ''),
        deviceType: typeSelect?.value ?? [],
        eep: eepSelect?.value ?? [],
    };
}

function applyFilterToForm(f: EoFilter | null): void {
    const set = (id: string, v: string) => {
        const el = byId<HTMLInputElement>(id);
        if (el) el.value = v;
    };
    set('eo_f_name', f?.name || '');
    set('eo_f_global', (f?.global || []).join(', '));
    set('eo_f_addr', (f?.address || []).join(', '));
    set('eo_f_ext', (f?.externalAddress || []).join(', '));
    if (typeSelect) typeSelect.value = f?.deviceType || [];
    if (eepSelect) eepSelect.value = f?.eep || [];
}

function refreshFilterNames(): void {
    const list = byId('eo_f_saved');
    if (!list) return;
    list.innerHTML = Object.keys(eoApp.doc.filters)
        .sort()
        .map((n) => `<option value="${escapeHtml(n)}"></option>`)
        .join('');
}

function initFilterBar(): void {
    const typeHost = byId('eo_f_type');
    if (typeHost) {
        typeSelect = new MultiSelect(typeHost, 'Gerätetyp', () => renderTable());
        typeSelect.setOptions(knownDeviceTypes());
    }
    const eepHost = byId('eo_f_eep');
    if (eepHost) {
        eepSelect = new MultiSelect(eepHost, 'EEP', () => renderTable());
        eepSelect.setOptions(eepNames());
    }

    for (const id of ['eo_f_global', 'eo_f_addr', 'eo_f_ext']) {
        byId(id)?.addEventListener('input', () => renderTable());
    }
    byId<HTMLInputElement>('eo_f_onlyha')?.addEventListener('change', (e) => {
        onlyHa = (e.target as HTMLInputElement).checked;
        renderTable();
    });

    byId('eo_f_load')?.addEventListener('click', () => {
        const name = byId<HTMLInputElement>('eo_f_name')?.value.trim() || '';
        const f = eoApp.doc.filters[name];
        if (!f) {
            eoApp.ctx.say(`Filter „${name}“ nicht gefunden`);
            return;
        }
        applyFilterToForm(f);
        eoApp.doc.selectedFilter = name;
        eoApp.touch();
        renderTable();
    });

    byId('eo_f_save')?.addEventListener('click', () => {
        const f = currentFilter();
        if (f.name.length < 2) {
            eoApp.ctx.say('Bitte einen Filternamen (min. 2 Zeichen) angeben');
            return;
        }
        eoApp.doc.filters[f.name] = f;
        eoApp.doc.selectedFilter = f.name;
        refreshFilterNames();
        eoApp.touch();
        eoApp.ctx.say(`Filter „${f.name}“ gespeichert`);
    });

    byId('eo_f_del')?.addEventListener('click', () => {
        const name = byId<HTMLInputElement>('eo_f_name')?.value.trim() || '';
        if (!(name in eoApp.doc.filters)) return;
        delete eoApp.doc.filters[name];
        if (eoApp.doc.selectedFilter === name) eoApp.doc.selectedFilter = null;
        refreshFilterNames();
        applyFilterToForm(null);
        eoApp.touch();
        renderTable();
    });

    byId('eo_f_reset')?.addEventListener('click', () => {
        applyFilterToForm(null);
        const cb = byId<HTMLInputElement>('eo_f_onlyha');
        if (cb) cb.checked = false;
        onlyHa = false;
        eoApp.doc.selectedFilter = null;
        eoApp.touch();
        renderTable();
    });
}

// -----------------------------------------------------------------------------
// Tabelle
// -----------------------------------------------------------------------------

const COLUMNS: Array<{ key: SortKey; label: string }> = [
    { key: 'name', label: 'Name' },
    { key: 'address', label: 'Adresse' },
    { key: 'externalId', label: 'Externe ID' },
    { key: 'deviceType', label: 'Typ' },
    { key: 'eep', label: 'EEP' },
    { key: 'haPlatform', label: 'Plattform' },
    { key: 'useInHa', label: 'In HA' },
    { key: 'rssi', label: 'Signal' },
    { key: 'lastSeen', label: 'Zuletzt' },
];

function visibleDevices(): EoDevice[] {
    const filter = currentFilter();
    const active = isEmptyFilter(filter) ? null : filter;
    let list = eoApp.devices().filter((d) => deviceMatchesFilter(d, active));
    if (onlyHa) list = list.filter((d) => d.useInHa);

    const dir = sortAsc ? 1 : -1;
    return list.sort((a, b) => {
        // Signal ist null, solange kein Telegramm kam (oder bei Bus-Geraeten).
        // Solche Zeilen gehoeren ans Ende, egal in welche Richtung sortiert
        // wird - sonst stehen sie beim Suchen nach dem besten Signal oben.
        if (sortKey === 'rssi') {
            if (a.rssi === null && b.rssi === null) return 0;
            if (a.rssi === null) return 1;
            if (b.rssi === null) return -1;
            return (a.rssi - b.rssi) * dir;
        }
        const x = a[sortKey];
        const y = b[sortKey];
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        if (typeof x === 'boolean' && typeof y === 'boolean') return (Number(x) - Number(y)) * dir;
        return String(x ?? '').localeCompare(String(y ?? ''), 'de') * dir;
    });
}

export function renderTable(): void {
    const head = byId('eo_thead');
    if (head) {
        head.innerHTML =
            '<tr>' +
            COLUMNS.map(
                (c) =>
                    `<th data-sort="${c.key}" style="cursor:pointer">${escapeHtml(c.label)}` +
                    `${sortKey === c.key ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>`,
            ).join('') +
            '</tr>';
    }

    const body = byId('eo_tbody');
    if (!body) return;

    const list = visibleDevices();
    const total = eoApp.devices().length;
    const count = byId('eo_count');
    if (count) {
        count.textContent = list.length === total
            ? `${total} Geräte`
            : `${list.length} von ${total} Geräten`;
    }

    if (!list.length) {
        body.innerHTML =
            `<tr><td colspan="${COLUMNS.length}" class="hint">` +
            (total ? 'kein Gerät passt zum Filter' : 'noch keine Geräte — empfangene Absender erscheinen automatisch') +
            '</td></tr>';
        return;
    }

    body.innerHTML = list.map(rowHtml).join('');
}

function rowHtml(d: EoDevice): string {
    const sel = d.externalId === selectedId ? ' style="background:var(--muted)"' : '';
    const cell = (label: string, value: string, mono = false) =>
        `<td data-label="${label}"${mono ? ' style="font-family:ui-monospace,monospace"' : ''}>${value}</td>`;

    return (
        `<tr data-id="${escapeHtml(d.externalId)}"${sel}>` +
        cell('Name', escapeHtml(d.name)) +
        cell('Adresse', escapeHtml(d.address), true) +
        cell('Externe ID', escapeHtml(d.externalId), true) +
        cell('Typ', escapeHtml(d.deviceType)) +
        cell('EEP', escapeHtml(d.eep)) +
        cell('Plattform', escapeHtml(d.haPlatform)) +
        cell('In HA', d.useInHa ? 'ja' : '—') +
        cell('Signal', escapeHtml(formatRssi(d.rssi))) +
        cell('Zuletzt', fmtClock(d.lastSeen)) +
        '</tr>'
    );
}

function initTable(): void {
    byId('eo_thead')?.addEventListener('click', (e) => {
        const th = (e.target as HTMLElement).closest('th');
        const key = th?.getAttribute('data-sort') as SortKey | null;
        if (!key) return;
        if (key === sortKey) sortAsc = !sortAsc;
        else { sortKey = key; sortAsc = true; }
        renderTable();
    });

    byId('eo_tbody')?.addEventListener('click', (e) => {
        const tr = (e.target as HTMLElement).closest('tr');
        const id = tr?.getAttribute('data-id');
        if (!id) return;
        selectedId = id;
        renderTable();
        renderDetails();
    });

    byId('eo_add')?.addEventListener('click', () => {
        const address = prompt('Adresse des neuen Geräts (z.B. 01-A2-B3-C4):', '00-00-00-00');
        if (!address) return;
        const id = address.trim().toUpperCase();
        if (!/^[0-9A-F]{2}(-[0-9A-F]{2}){3}$/.test(id)) {
            eoApp.ctx.say('Ungültige Adresse — erwartet AA-BB-CC-DD');
            return;
        }
        if (eoApp.doc.devices[id]) {
            eoApp.ctx.say('Gerät existiert bereits');
        } else {
            eoApp.doc.devices[id] = newDevice({ address: id, externalId: id, name: `Gerät ${id}` });
        }
        selectedId = id;
        eoApp.touch();
        renderDetails();
    });

    byId('eo_suggest_all')?.addEventListener('click', () => {
        if (!confirm('HA-Eigenschaften aller Geräte auf die Katalog-Vorschläge zurücksetzen?')) return;
        for (const d of eoApp.devices()) suggestHaConfig(d);
        eoApp.touch();
        renderDetails();
        eoApp.ctx.say('Vorschläge übernommen');
    });

    byId('eo_clear')?.addEventListener('click', async () => {
        if (!confirm('Wirklich ALLE Geräte, Filter und Vorlagen löschen?')) return;
        eoApp.doc.devices = {};
        eoApp.doc.filters = {};
        eoApp.doc.selectedFilter = null;
        eoApp.doc.templates = [];
        selectedId = null;
        try {
            await eoApp.store?.clear();
        } catch (e) {
            eoApp.ctx.say(`Löschen auf dem Gerät fehlgeschlagen: ${String(e)}`);
        }
        refreshFilterNames();
        applyFilterToForm(null);
        eoApp.touch(false);
        renderDetails();
    });
}

// -----------------------------------------------------------------------------
// Detailformular
// -----------------------------------------------------------------------------

function renderDetails(): void {
    const box = byId('eo_details');
    if (!box) return;

    const d = selectedId ? eoApp.get(selectedId) : undefined;
    if (!d) {
        box.innerHTML = '<div class="hint">Kein Gerät ausgewählt — eine Zeile in der Tabelle anklicken.</div>';
        return;
    }

    const eepChoices = eepNames(eepClass(d.eep) || undefined);
    // Ein bereits gesetztes EEP muss auswaehlbar bleiben, auch wenn es im
    // Katalog fehlt - sonst faellt es beim naechsten Speichern still weg.
    if (d.eep && !eepChoices.includes(d.eep)) eepChoices.unshift(d.eep);

    box.innerHTML = `
      <div class="eo-grid">
        <label>Name</label><input type="text" id="eo_d_name" value="${escapeHtml(d.name)}" maxlength="60">
        <label>Adresse</label><input type="text" id="eo_d_addr" value="${escapeHtml(d.address)}" readonly>
        <label>Base-ID</label><input type="text" id="eo_d_base" value="${escapeHtml(d.baseId)}" readonly>
        <label>Externe ID</label><input type="text" id="eo_d_ext" value="${escapeHtml(d.externalId)}" readonly>
        <label>Version</label><input type="text" id="eo_d_ver" value="${escapeHtml(d.version)}" maxlength="16">
        <label>Gerätetyp</label>
        <span><input type="text" id="eo_d_type" list="eo_types" value="${escapeHtml(d.deviceType)}" maxlength="40"></span>
        <label>Eltako-Funkgerät</label>
        <select id="eo_d_eltako">${eltakoOptions(d)}</select>
        <label>Tastenfunktion</label>
        <select id="eo_d_kf">${optionList(KEY_FUNCTION_NAMES, d.keyFunction, '— keine —')}</select>
        <label>Kommentar</label><input type="text" id="eo_d_comment" value="${escapeHtml(d.comment)}" maxlength="120">
        <label>EEP</label>
        <select id="eo_d_eep">${optionList(
            eepChoices.map((e) => ({ value: e, label: eepTitle(e) ? `${e} — ${eepTitle(e)}` : e })),
            d.eep,
            '— unbekannt —',
        )}</select>
        <label>HA-Plattform</label>
        <select id="eo_d_platform">${optionList([...HA_PLATFORMS], d.haPlatform, '— keine —')}</select>
        <label>In HA verwenden</label>
        <span><label class="inline"><input type="checkbox" id="eo_d_useha"${d.useInHa ? ' checked' : ''}> exportieren</label></span>
      </div>

      <label style="margin-top:10px">Zusatzfelder (Home Assistant)</label>
      <div id="eo_d_add">${additionalFieldsHtml(d.additional)}</div>
      <div class="row" style="margin-top:6px">
        <input type="text" id="eo_d_addkey" list="eo_ha_fields" placeholder="Feldname, z.B. fast_status_change" maxlength="40">
        <input type="text" id="eo_d_addval" placeholder="Wert, z.B. true" maxlength="80">
        <button type="button" class="ghost" id="eo_d_addbtn">Feld hinzufügen</button>
      </div>

      ${memoryHtml(d)}
      ${relatedHtml(d)}

      <div class="row" style="margin-top:10px">
        <button type="button" id="eo_d_apply">Übernehmen</button>
        <button type="button" class="ghost" id="eo_d_suggest">Vorschlag aus Katalog</button>
        <button type="button" class="ghost" id="eo_d_reload">Verwerfen</button>
        <button type="button" class="danger" id="eo_d_delete">Löschen</button>
      </div>
      <div class="hint" id="eo_d_info">${escapeHtml(catalogHint(d))}</div>
    `;

    byId('eo_d_apply')?.addEventListener('click', () => applyDetails(d));
    byId('eo_d_addbtn')?.addEventListener('click', () => {
        const key = byId<HTMLInputElement>('eo_d_addkey')?.value.trim() ?? '';
        const value = byId<HTMLInputElement>('eo_d_addval')?.value.trim() ?? '';
        if (!key) { eoApp.ctx.say('Feldname fehlt'); return; }
        if (!/^[a-z0-9_]+$/i.test(key)) {
            eoApp.ctx.say('Feldname darf nur Buchstaben, Ziffern und _ enthalten');
            return;
        }
        applyDetails(d, false);
        d.additional[key] = value;
        eoApp.touch();
        renderDetails();
    });
    // Zusatzfeld entfernen (nur die selbst angelegten bzw. nicht mehr
    // gewuenschten - "Vorschlag aus Katalog" stellt die Standardfelder wieder her).
    byId('eo_d_add')?.addEventListener('click', (e) => {
        const key = (e.target as HTMLElement).getAttribute('data-del-field');
        if (!key) return;
        applyDetails(d, false);
        delete d.additional[key];
        eoApp.touch();
        renderDetails();
    });
    byId('eo_d_reload')?.addEventListener('click', () => renderDetails());
    byId('eo_d_suggest')?.addEventListener('click', () => {
        applyDetails(d, false);
        suggestHaConfig(d, true);
        eoApp.touch();
        renderDetails();
    });
    byId('eo_d_delete')?.addEventListener('click', () => {
        if (!confirm(`Gerät ${d.externalId} wirklich löschen?`)) return;
        eoApp.remove(d.externalId);
        selectedId = null;
        renderDetails();
    });
    // Typwechsel schlaegt sofort den passenden Katalogeintrag vor - genau wie
    // die Combobox im Desktop-Tool.
    byId('eo_d_type')?.addEventListener('change', () => {
        applyDetails(d, false);
        suggestHaConfig(d, true);
        eoApp.touch();
        renderDetails();
    });
    // Modellauswahl setzt Typ UND EEP in einem Schritt - fuer Funksender ist
    // das der schnellste Weg, weil der Typ allein mehrdeutig sein kann.
    byId('eo_d_eltako')?.addEventListener('change', (e) => {
        const key = (e.target as HTMLSelectElement).value;
        const model = ELTAKO_DEVICES.find((x) => x.key === key);
        if (!model) return;
        applyDetails(d, false);
        d.deviceType = model.model;
        d.eep = model.eep;
        suggestHaConfig(d, true);
        eoApp.touch();
        renderTable();
        renderDetails();
    });
    // Tastenfunktion kann das EEP mitbringen (…_ACCORDING_TO_EEP_A5_07_01).
    byId('eo_d_kf')?.addEventListener('change', (e) => {
        const kf = (e.target as HTMLSelectElement).value;
        const derived = eepFromKeyFunctionName(kf);
        if (derived) {
            const eepSel = byId<HTMLSelectElement>('eo_d_eep');
            if (eepSel && Array.from(eepSel.options).some((o) => o.value === derived)) {
                eepSel.value = derived;
            }
        }
    });
}

function applyDetails(d: EoDevice, rerender = true): void {
    const val = (id: string) => byId<HTMLInputElement>(id)?.value.trim() ?? '';
    d.name = val('eo_d_name');
    d.version = val('eo_d_ver');
    d.deviceType = val('eo_d_type');
    d.comment = val('eo_d_comment');
    d.keyFunction = byId<HTMLSelectElement>('eo_d_kf')?.value ?? '';
    d.eep = byId<HTMLSelectElement>('eo_d_eep')?.value ?? '';
    d.haPlatform = byId<HTMLSelectElement>('eo_d_platform')?.value ?? '';
    d.useInHa = byId<HTMLInputElement>('eo_d_useha')?.checked ?? false;

    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('#eo_d_add input[data-path]'))) {
        setByPath(d.additional, input.getAttribute('data-path') as string, input.value.trim());
    }

    eoApp.touch();
    if (rerender) {
        renderTable();
        renderDetails();
        eoApp.ctx.say(`${d.name || d.externalId} übernommen`);
    }
}

function setByPath(fields: Record<string, AddField>, path: string, value: string): void {
    const parts = path.split('.');
    const key = parts.pop() as string;
    let target: Record<string, AddField> = fields;
    for (const p of parts) {
        const next = target[p];
        if (!next || typeof next !== 'object') return;
        target = next as Record<string, AddField>;
    }
    // Den Typ des vorhandenen Werts beibehalten. Reine Zahlenerkennung waere
    // falsch: die Sender-ID "01" ist eine Hex-Zahl und muss zweistellig als
    // Text bleiben, sonst wird beim Export aus 01 die Zahl 1.
    const previous = target[key];
    if (typeof previous === 'number') {
        const asNumber = Number(value);
        target[key] = Number.isFinite(asNumber) ? asNumber : previous;
    } else {
        target[key] = value;
    }
}

function additionalFieldsHtml(fields: Record<string, AddField>, prefix = ''): string {
    const entries = Object.entries(fields);
    if (!entries.length && !prefix) {
        return '<div class="hint">keine — ergeben sich aus Gerätetyp bzw. „Vorschlag aus Katalog“, weitere unten hinzufügbar</div>';
    }
    let out = '<div class="eo-grid">';
    for (const [key, value] of entries) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') {
            out += `</div><label style="margin-top:6px">${escapeHtml(key)}${delButton(prefix, key)}</label>`;
            out += additionalFieldsHtml(value as Record<string, AddField>, path);
            out += '<div class="eo-grid">';
            continue;
        }
        out +=
            `<label>${escapeHtml(key)}${delButton(prefix, key)}</label>` +
            `<input type="text" data-path="${escapeHtml(path)}" value="${escapeHtml(String(value))}">`;
    }
    return out + '</div>';
}

/**
 * Entfernen-Kreuz - nur auf oberster Ebene, verschachtelte Gruppen als Ganzes.
 * Bewusst ein <span> und kein <a href="#">: letzteres wuerde den Hash aendern
 * und damit den Reiter wechseln.
 */
function delButton(prefix: string, key: string): string {
    if (prefix) return '';
    return (
        ` <span data-del-field="${escapeHtml(key)}" role="button" tabindex="0" ` +
        `title="Feld entfernen" style="color:var(--danger);cursor:pointer">✕</span>`
    );
}

function memoryHtml(d: EoDevice): string {
    if (!d.memory.length) return '';
    const rows = d.memory
        .map(
            (m) =>
                `<tr><td>${m.line}</td><td style="font-family:ui-monospace,monospace">${escapeHtml(m.sensorId)}</td>` +
                `<td>${escapeHtml(keyFunctionName(m.keyFunc))}</td></tr>`,
        )
        .join('');
    return `
      <label style="margin-top:10px">Gerätespeicher (${d.memory.length} Einträge)</label>
      <div style="max-height:220px;overflow:auto">
        <table><thead><tr><th>Zeile</th><th>Sender</th><th>Funktion</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
}

function relatedHtml(d: EoDevice): string {
    const rel = relatedDevices(eoApp.doc, d.externalId);
    if (!rel.length) return '';
    const rows = rel
        .map(
            (r) =>
                `<tr><td>${escapeHtml(r.name)}</td>` +
                `<td style="font-family:ui-monospace,monospace">${escapeHtml(r.address)}</td>` +
                `<td>${escapeHtml(r.deviceType)}</td></tr>`,
        )
        .join('');
    return `
      <label style="margin-top:10px">Verknüpfte Geräte (${rel.length})</label>
      <div style="max-height:220px;overflow:auto">
        <table><thead><tr><th>Name</th><th>Adresse</th><th>Typ</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
}

/**
 * Auswahl der Eltako-Funkgeraete, passend zur Telegrammklasse des Absenders.
 * Ohne bekanntes RORG (z.B. von Hand angelegte Geraete) alle anbieten.
 */
function eltakoOptions(d: EoDevice): string {
    const prefix = d.rorg ? d.rorg.toString(16).padStart(2, '0') : undefined;
    const models = eltakoModelsFor(prefix);
    const current = models.find((m) => m.model === d.deviceType && m.eep === d.eep);
    return optionList(
        models.map((m) => ({ value: m.key, label: `${m.model} — ${m.typ} (${m.eep})` })),
        current?.key ?? '',
        '— (nicht zugeordnet) —',
    );
}

function catalogHint(d: EoDevice): string {
    const info = findByDeviceType(d.deviceType, d.eep || undefined) || findByDeviceType(d.deviceType);
    if (!info) return 'Gerätetyp nicht im Katalog — EEP und Plattform bitte manuell setzen.';
    const bits = [`${info.hw}${info.brand ? ` (${info.brand})` : ''}`];
    if (info.desc) bits.push(info.desc);
    if (info.channels && info.channels > 1) bits.push(`${info.channels} Kanäle`);
    if (info.pct14Fg !== undefined) {
        bits.push(`PCT14: Funktionsgruppe ${info.pct14Fg}, Funktion ${info.pct14Kf}`);
    }
    return bits.join(' · ');
}

// -----------------------------------------------------------------------------

export function initDevicesTab(): void {
    const list = byId('eo_types');
    if (list) list.innerHTML = knownDeviceTypes().map((t) => `<option value="${escapeHtml(t)}"></option>`).join('');

    initFilterBar();
    initTable();

    eoApp.onDevicesChanged(() => {
        refreshFilterNames();
        renderTable();
        // Ausgewaehltes Geraet kann weggeloescht worden sein.
        if (selectedId && !eoApp.get(selectedId)) {
            selectedId = null;
            renderDetails();
        }
    });

    // Gespeicherten Filter beim Start anwenden.
    const selected = eoApp.doc.selectedFilter;
    if (selected && eoApp.doc.filters[selected]) applyFilterToForm(eoApp.doc.filters[selected]);

    refreshFilterNames();
    renderTable();
    renderDetails();
}
