// PCT14-Export lesen und schreiben.
//
// Portierung von eo_man/data/pct14_data_manager.py. Das ist fuer den EUL der
// wichtigste Weg an den Bestand einer Baureihe-14-Anlage zu kommen: der EUL
// hat keinen RS485-Zugang, kann die Aktoren also nicht wie EO-Man ueber einen
// FAM14 auslesen. Ein PCT14-Export liefert dieselben Daten - Adressen,
// Typen, Beschreibungen und die komplette Speicherbelegung.
//
// Zweite Richtung: einen bestehenden Export um die HA-Sender-IDs ergaenzen,
// damit die Aktoren die von Home Assistant erzeugten Telegramme annehmen.

import { a2i, a2s, addAddresses, findByDeviceType, normalizeHwType } from './catalog';
import { newDevice, type EoDevice, type EoDocument, type MemoryEntry } from './model';
import { suggestHaConfig } from './suggest';

export interface Pct14Import {
    baseId: string;
    devices: EoDevice[];
    warnings: string[];
}

export interface Pct14Extend {
    xml: string;
    added: number;
    warnings: string[];
}

/**
 * Speicherbereiche, in die ein Sender eingetragen werden darf - je Aktortyp
 * verschieden. Werte aus eltakobus/device.py (sensor_address_range); Typen
 * ohne Eintrag koennen nicht automatisch ergaenzt werden.
 */
const SENSOR_RANGES: Array<[string, [number, number]]> = [
    ['FUD14', [8, 127]],
    ['FUD14_800W', [8, 127]],
    ['FSR14', [8, 127]],
    ['FSR14_1X', [8, 127]],
    ['FSR14_2X', [8, 127]],
    ['FSR14M_2X', [8, 127]],
    ['FSR14_4X', [8, 127]],
    ['F4SR14_LED', [8, 127]],
    ['FSB14', [17, 127]],
    ['FMZ14', [8, 55]],
    ['FDG14', [14, 127]],
    ['FD2G14', [14, 127]],
    ['FAE14SSR', [14, 127]],
    ['FHK14', [14, 127]],
    ['F4HK14', [20, 127]],
    ['FTD14', [8, 127]],
];

function sensorRange(deviceType: string): [number, number] | null {
    const want = normalizeHwType(deviceType);
    const hit = SENSOR_RANGES.find(([name]) => name === want);
    return hit ? hit[1] : null;
}

// -----------------------------------------------------------------------------
// XML-Helfer
// -----------------------------------------------------------------------------

function childText(parent: Element | null, path: string): string {
    if (!parent) return '';
    let el: Element | null = parent;
    for (const tag of path.split('>')) {
        el = el ? el.querySelector(`:scope > ${tag.trim()}`) : null;
        if (!el) return '';
    }
    return (el.textContent || '').trim();
}

function childInt(parent: Element | null, path: string): number {
    const n = parseInt(childText(parent, path), 10);
    return Number.isFinite(n) ? n : 0;
}

/**
 * PCT14 speichert Adressen als Ganzzahl mit umgedrehter Bytereihenfolge.
 * 0x01B00000 -> "00-00-B0-01".
 */
export function pct14IdToAddress(value: number | string): string {
    const n = typeof value === 'number' ? value : parseInt(value, 10);
    if (!Number.isFinite(n)) return '00-00-00-00';
    const hex = (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const bytes = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)];
    return bytes.reverse().join('-');
}

/** Umkehrung: "00-00-B0-01" -> 0x01B00000 als Dezimalzahl. */
export function addressToPct14Id(address: string): number {
    const parts = address.split('-');
    while (parts.length < 4) parts.unshift('00');
    return parseInt(parts.slice(0, 4).reverse().join(''), 16) >>> 0;
}

// -----------------------------------------------------------------------------
// Import
// -----------------------------------------------------------------------------

/** Liest einen PCT14-XML-Export in Geraete des Portal-Modells um. */
export function importPct14(xmlText: string): Pct14Import {
    const warnings: string[] = [];
    const dom = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (dom.querySelector('parsererror')) {
        throw new Error('Datei ist kein gültiges XML.');
    }
    const exchange = dom.querySelector('exchange');
    if (!exchange) throw new Error("Kein <exchange>-Element - das ist kein PCT14-Export.");

    const root = exchange.querySelector(':scope > rootdevice');
    if (!root) throw new Error('Kein <rootdevice> im Export - Base-ID nicht ermittelbar.');

    const baseId = readBaseId(root);
    const devices: EoDevice[] = [];

    // FAM14 selbst als Gateway aufnehmen - der HA-Export braucht die Base-ID,
    // und in der Tabelle ist sichtbar, woher der Bestand stammt.
    const fam14 = newDevice({
        address: baseId,
        externalId: baseId,
        baseId,
        busDevice: true,
        deviceType: 'fam14',
        comment: childText(root, 'description'),
        useInHa: false,
    });
    fam14.name = fam14.comment ? `FAM14 - ${fam14.comment}` : `FAM14 - ${baseId}`;
    devices.push(fam14);

    const deviceNodes = exchange.querySelectorAll(':scope > devices > device');
    if (!deviceNodes.length) warnings.push('Der Export enthält keine <device>-Einträge.');

    for (const node of Array.from(deviceNodes)) {
        const hwType = childText(node, 'name');
        const baseAddress = childInt(node, 'header > address');
        const devSize = Math.max(1, childInt(node, 'header > addressrange'));

        const memory = readMemoryEntries(node);

        for (let channel = 1; channel <= devSize; channel++) {
            const address = a2s(baseAddress + channel - 1);
            const d = newDevice({
                address,
                externalId: addAddresses(address, baseId),
                baseId,
                busDevice: true,
                channel,
                devSize,
                deviceType: hwType,
                version: readVersion(node),
                comment: readComment(node, channel),
                useInHa: true,
                // Nur die Eintraege dieses Kanals: die Kanalmaske ist ein
                // Bitfeld, Kanal 1 = Bit 0.
                memory: memory.filter((m) => m.channel === 0 || (m.channel & (1 << (channel - 1))) !== 0),
            });

            d.name = d.comment
                ? `${hwType.toUpperCase()} - ${d.comment}`
                : `${hwType.toUpperCase()} - ${address}` + (devSize > 1 ? ` (${channel}/${devSize})` : '');

            suggestHaConfig(d, true);
            if (!findByDeviceType(hwType)) {
                warnings.push(`Typ '${hwType}' (${address}) ist im Katalog unbekannt - EEP bitte manuell setzen.`);
            }
            devices.push(d);

            // Jeder eingetragene Sender ist selbst ein Geraet (Taster,
            // Fensterkontakt, ...) und gehoert in den Bestand.
            for (const m of d.memory) {
                const sensor = sensorFromMemoryEntry(m, baseId);
                if (sensor) devices.push(sensor);
            }
        }
    }

    return { baseId, devices, warnings };
}

function readBaseId(root: Element): string {
    const parts: string[] = [];
    for (let i = 0; i < 4; i++) {
        const v = childInt(root, `rootdevicedata > baseid > baseid_byte_${i}`);
        parts.push(v.toString(16).toUpperCase().padStart(2, '0'));
    }
    return parts.join('-');
}

function readVersion(node: Element): string {
    const raw = childInt(node, 'header > versionofsoftware');
    if (!raw) return '';
    const hex = raw.toString(16).toUpperCase();
    return hex.length >= 2 ? `${hex[0]}.${hex[1]}` : hex;
}

function readComment(node: Element, channel: number): string {
    let comment = childText(node, 'description');
    for (const c of Array.from(node.querySelectorAll(':scope > channels > channel'))) {
        const num = parseInt(c.getAttribute('channelnumber') || '0', 10);
        const desc = (c.getAttribute('description') || '').trim();
        if (num === channel && desc) comment = comment ? `${comment} - ${desc}` : desc;
    }
    return comment;
}

function readMemoryEntries(node: Element): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const e of Array.from(node.querySelectorAll(':scope > data > rangeofid > entry'))) {
        const id = childText(e, 'entry_id');
        if (!id) continue;
        // Abweichung vom Original: dort werden line/keyFunc/channel/button mit
        // getattr() aus einem dict gelesen und landen deshalb immer auf 0.
        // Ohne diese Felder gaebe es weder Tastenfunktionen noch verknuepfte
        // Geraete - hier also korrekt ausgelesen.
        out.push({
            line: childInt(e, 'entry_number'),
            sensorId: pct14IdToAddress(id),
            keyFunc: childInt(e, 'entry_function'),
            channel: childInt(e, 'entry_channel'),
            button: childInt(e, 'entry_button'),
        });
    }
    return out;
}

/** Baut aus einem Speichereintrag das zugehoerige Sensor-Geraet. */
function sensorFromMemoryEntry(m: MemoryEntry, baseId: string): EoDevice | null {
    // Von Home Assistant erzeugte virtuelle Sender (ab 00-00-B0-00) sind keine
    // echten Geraete - sie wuerden die Liste nur zumuellen.
    if (m.sensorId.toUpperCase().startsWith('00-00-B')) return null;

    const local = m.sensorId.toUpperCase().startsWith('00-00-');
    const d = newDevice({
        address: m.sensorId,
        externalId: local ? addAddresses(m.sensorId, baseId) : m.sensorId,
        baseId: local ? baseId : '00-00-00-00',
        busDevice: false,
        deviceType: 'Sensor',
        keyFunction: '',
        useInHa: false,
    });
    d.name = `Sensor ${m.sensorId}`;
    return d;
}

// -----------------------------------------------------------------------------
// Export: HA-Sender-IDs in einen bestehenden PCT14-Export eintragen
// -----------------------------------------------------------------------------

/**
 * Ergaenzt einen PCT14-Export um die im Portal vergebenen HA-Sender-IDs.
 * Die erzeugte Datei kann in PCT14 eingelesen und auf die Aktoren geschrieben
 * werden - danach reagieren sie auf Home Assistant.
 *
 * `senderOffset` ist die Basis, auf die die (1..127) Sender-IDs addiert
 * werden - bei einem Bus-Gateway 00-00-B0-00.
 */
export function extendPct14Export(
    xmlText: string,
    doc: EoDocument,
    senderOffset: string,
): Pct14Extend {
    const warnings: string[] = [];
    const dom = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (dom.querySelector('parsererror')) throw new Error('Datei ist kein gültiges XML.');

    const exchange = dom.querySelector('exchange');
    const root = exchange?.querySelector(':scope > rootdevice');
    if (!exchange || !root) throw new Error("Kein <exchange>/<rootdevice> - das ist kein PCT14-Export.");

    const baseId = readBaseId(root);
    let added = 0;

    for (const node of Array.from(exchange.querySelectorAll(':scope > devices > device'))) {
        const hwType = childText(node, 'name');
        const info = findByDeviceType(hwType);
        if (!info || info.pct14Kf === undefined) {
            warnings.push(`Typ '${hwType}': keine PCT14-Tastenfunktion im Katalog - übersprungen.`);
            continue;
        }
        const range = sensorRange(hwType);
        if (!range) {
            warnings.push(`Typ '${hwType}': Speicherbereich unbekannt - übersprungen.`);
            continue;
        }

        const rangeOfId = ensureRangeOfId(dom, node);
        const baseAddress = childInt(node, 'header > address');
        const devSize = Math.max(1, childInt(node, 'header > addressrange'));

        for (let channel = 1; channel <= devSize; channel++) {
            const externalId = addAddresses(a2s(baseAddress + channel - 1), baseId);
            const device = doc.devices[externalId];
            const sender = device?.additional.sender;
            if (!device || !sender || typeof sender !== 'object') continue;

            const senderIdHex = String((sender as Record<string, unknown>).id ?? '');
            if (!senderIdHex) continue;

            const fullSenderId = a2s((parseInt(senderIdHex, 16) + a2i(senderOffset)) >>> 0);
            if (isRegistered(rangeOfId, fullSenderId, channel, info.pct14Kf)) continue;

            const slot = freeEntryNumber(rangeOfId, range);
            if (slot === null) {
                warnings.push(
                    `${device.name} (${externalId}): kein freier Speicherplatz im Aktor - ` +
                        'bitte in PCT14 manuell aufräumen.',
                );
                continue;
            }

            rangeOfId.appendChild(
                buildEntry(dom, {
                    entry_number: slot,
                    entry_id: addressToPct14Id(fullSenderId),
                    entry_function: info.pct14Kf,
                    entry_button: 0,
                    entry_channel: 1 << (channel - 1),
                    entry_value: 0,
                }),
            );
            added++;
        }
    }

    const xml = new XMLSerializer().serializeToString(dom);
    return { xml, added, warnings };
}

function ensureRangeOfId(dom: Document, device: Element): Element {
    let data = device.querySelector(':scope > data');
    if (!data) {
        data = dom.createElement('data');
        device.appendChild(data);
    }
    let range = data.querySelector(':scope > rangeofid');
    if (!range) {
        range = dom.createElement('rangeofid');
        data.appendChild(range);
    }
    return range;
}

function isRegistered(rangeOfId: Element, senderId: string, channel: number, keyFunc: number): boolean {
    for (const e of Array.from(rangeOfId.querySelectorAll(':scope > entry'))) {
        const entryChannel = childInt(e, 'entry_channel');
        if (!(entryChannel & (1 << (channel - 1)))) continue;
        if (childInt(e, 'entry_function') !== keyFunc) continue;
        if (pct14IdToAddress(childText(e, 'entry_id')) === senderId) return true;
    }
    return false;
}

function freeEntryNumber(rangeOfId: Element, [from, to]: [number, number]): number | null {
    const used = new Set(
        Array.from(rangeOfId.querySelectorAll(':scope > entry')).map((e) => childInt(e, 'entry_number')),
    );
    for (let i = from; i < to; i++) {
        if (!used.has(i)) return i;
    }
    return null;
}

function buildEntry(dom: Document, fields: Record<string, number>): Element {
    const entry = dom.createElement('entry');
    for (const [key, value] of Object.entries(fields)) {
        const el = dom.createElement(key);
        el.textContent = String(value);
        entry.appendChild(el);
    }
    return entry;
}
