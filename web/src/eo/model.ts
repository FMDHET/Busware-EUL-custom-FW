// Datenmodell des Geraete-Managers und Persistenz gegen /api/eo.
//
// Portierung von eo_man/data/device.py (Device) und
// eo_man/data/application_data.py (ApplicationData). Das Dokument ist das
// Gegenstueck zur .eodm-Datei des Desktop-Tools, liegt hier aber auf dem
// Geraet (SPIFFS) statt auf der Festplatte - damit sieht jeder Browser
// denselben Bestand.

import { a2i, a2s, isLocalBusAddress } from './catalog';

export const EO_DOC_VERSION = 1;

/** Ein Zusatzfeld der HA-Konfiguration: Skalar oder verschachtelte Gruppe. */
export type AddField = string | number | boolean | Record<string, string | number | boolean>;

/** Speichereintrag eines Bus-Aktors (aus PCT14-Import). */
export interface MemoryEntry {
    /** Speicherzeile im Aktor. */
    line: number;
    /** Eingetragene Sensor-/Sender-Adresse. */
    sensorId: string;
    /** PCT14-Tastenfunktion (Nummer). */
    keyFunc: number;
    /** Kanal-Bitmaske des Aktors. */
    channel: number;
    button: number;
}

export interface EoDevice {
    /** Bus-lokale Adresse; bei Funkgeraeten identisch mit externalId. */
    address: string;
    /** Eindeutiger Schluessel im Bestand (weltweite Adresse). */
    externalId: string;
    /** Base-ID des Gateways; '00-00-00-00' bei echten Funkgeraeten. */
    baseId: string;
    /** true fuer Geraete am RS485-Bus (nur ueber PCT14-Import erreichbar). */
    busDevice: boolean;
    channel: number;
    devSize: number;
    /** Hardware-Typ aus dem Katalog, z.B. "FSR14_4x". */
    deviceType: string;
    version: string;
    name: string;
    comment: string;
    eep: string;
    haPlatform: string;
    useInHa: boolean;
    /** PCT14-Tastenfunktion als Name (nur Sensoren). */
    keyFunction: string;
    /** HA-Zusatzfelder: sender, device_class, time_opens, thermostat, ... */
    additional: Record<string, AddField>;
    /** Speicherbelegung des Aktors (PCT14-Import). */
    memory: MemoryEntry[];

    // --- Laufzeitinfos aus dem Funkverkehr -----------------------------------
    /** Zeitpunkt des letzten Telegramms (epoch ms, 0 = nie gesehen). */
    lastSeen: number;
    /** Signalstaerke des letzten Telegramms in dBm (null = unbekannt/Bus). */
    rssi: number | null;
    /** RORG des letzten Telegramms (0 = unbekannt). */
    rorg: number;
    /** Anzahl empfangener Telegramme seit dem letzten Portal-Start. */
    telegrams: number;
}

/** Gespeicherter Tabellenfilter (eo_man: DataFilter). */
export interface EoFilter {
    name: string;
    global: string[];
    address: string[];
    externalAddress: string[];
    deviceType: string[];
    eep: string[];
}

/** Favorit im Telegramm-Sender (eo_man: MessageHistoryEntry). */
export interface EoTemplate {
    name: string;
    /** Kompletter ESP3-Frame als Hex-String. */
    hex: string;
}

export interface EoDocument {
    version: number;
    devices: Record<string, EoDevice>;
    filters: Record<string, EoFilter>;
    selectedFilter: string | null;
    templates: EoTemplate[];
    /** Base-ID des eigenen TCM515 - Anker fuer den HA-Gateway-Block. */
    baseId: string;
}

export function emptyDocument(): EoDocument {
    return {
        version: EO_DOC_VERSION,
        devices: {},
        filters: {},
        selectedFilter: null,
        templates: [],
        baseId: '',
    };
}

export function newDevice(partial: Partial<EoDevice> = {}): EoDevice {
    return {
        address: '00-00-00-00',
        externalId: '00-00-00-00',
        baseId: '00-00-00-00',
        busDevice: false,
        channel: 1,
        devSize: 1,
        deviceType: '',
        version: '',
        name: '',
        comment: '',
        eep: '',
        haPlatform: '',
        useInHa: false,
        keyFunction: '',
        additional: {},
        memory: [],
        lastSeen: 0,
        rssi: null,
        rorg: 0,
        telegrams: 0,
        ...partial,
    };
}

/**
 * Fehlende Felder ergaenzen. Aeltere Dokumente (oder von Hand editierte
 * Backups) duerfen nicht dazu fuehren, dass die Oberflaeche auf undefined
 * laeuft. Gegenstueck zu ApplicationData._migrate.
 */
export function migrateDocument(raw: unknown): EoDocument {
    const doc = emptyDocument();
    if (!raw || typeof raw !== 'object') return doc;
    const r = raw as Partial<EoDocument>;

    if (typeof r.baseId === 'string') doc.baseId = r.baseId;
    if (typeof r.selectedFilter === 'string') doc.selectedFilter = r.selectedFilter;

    if (r.devices && typeof r.devices === 'object') {
        for (const [key, value] of Object.entries(r.devices)) {
            if (!value || typeof value !== 'object') continue;
            const d = newDevice(value as Partial<EoDevice>);
            // Schluessel gewinnt: er ist der Index, unter dem alles andere
            // (Filter, HA-Export, Telegramm-Zuordnung) das Geraet sucht.
            d.externalId = key;
            if (!d.address) d.address = key;
            if (!Array.isArray(d.memory)) d.memory = [];
            if (!d.additional || typeof d.additional !== 'object') d.additional = {};
            doc.devices[key] = d;
        }
    }

    if (r.filters && typeof r.filters === 'object') {
        for (const [key, value] of Object.entries(r.filters)) {
            if (!value || typeof value !== 'object') continue;
            const f = value as Partial<EoFilter>;
            doc.filters[key] = {
                name: key,
                global: asStrings(f.global),
                address: asStrings(f.address),
                externalAddress: asStrings(f.externalAddress),
                deviceType: asStrings(f.deviceType),
                eep: asStrings(f.eep),
            };
        }
    }
    if (doc.selectedFilter && !(doc.selectedFilter in doc.filters)) {
        doc.selectedFilter = null;
    }

    if (Array.isArray(r.templates)) {
        doc.templates = r.templates
            .filter((t): t is EoTemplate => !!t && typeof (t as EoTemplate).hex === 'string')
            .map((t) => ({ name: String(t.name ?? ''), hex: t.hex.toUpperCase() }));
    }

    return doc;
}

function asStrings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Zwei Erfassungen desselben Geraets zusammenfuehren. Vom Nutzer gepflegte
 * Felder (Name, Kommentar, Tastenfunktion) gewinnen gegen automatisch
 * erkannte - sonst wuerde ein PCT14-Reimport die Handarbeit wegwerfen.
 * (eo_man: Device.merge_devices, mit derselben Vorrangregel)
 */
export function mergeDevice(target: EoDevice, incoming: EoDevice): void {
    target.address = incoming.address;
    target.channel = incoming.channel;
    target.devSize = incoming.devSize;
    target.deviceType = incoming.deviceType;
    target.version = incoming.version;
    target.baseId = incoming.baseId;
    target.memory = incoming.memory;
    target.busDevice = target.busDevice || incoming.busDevice;
    target.useInHa = incoming.useInHa;
    target.eep = incoming.eep;

    if (!target.name || target.name === 'unknown') target.name = incoming.name;
    if (!target.comment) target.comment = incoming.comment;
    if (!target.keyFunction) target.keyFunction = incoming.keyFunction;

    for (const [k, v] of Object.entries(incoming.additional)) {
        if (!(k in target.additional)) target.additional[k] = v;
    }
}

/**
 * Geraet ueber eine bus-lokale Adresse finden: 00-00-00-xx wird mit der
 * Base-ID zur weltweiten Adresse addiert. (eo_man: find_device_by_local_address)
 */
export function findByLocalAddress(
    doc: EoDocument,
    address: string,
    baseId: string,
): EoDevice | null {
    let extId = address;
    if (isLocalBusAddress(address)) {
        const sum = a2i(address) + a2i(baseId);
        if (sum > 0xffffffff) return null;
        extId = a2s(sum);
    }
    return doc.devices[extId] || null;
}

/**
 * Alle Geraete, in deren Speicher dieser Sender eingetragen ist, plus alle
 * Sensoren, die im Speicher dieses Geraets stehen.
 * (eo_man: get_related_devices)
 */
export function relatedDevices(doc: EoDocument, externalId: string): EoDevice[] {
    const device = doc.devices[externalId];
    if (!device) return [];

    const out: EoDevice[] = [];
    const seen = new Set<string>();
    const push = (d: EoDevice | null | undefined) => {
        if (d && d.externalId !== externalId && !seen.has(d.externalId)) {
            seen.add(d.externalId);
            out.push(d);
        }
    };

    // Sensoren, die IN diesem Geraet konfiguriert sind. `memory` ist bereits
    // beim Import auf den Kanal dieses Geraets gefiltert - eine erneute
    // Pruefung waere falsch, weil `MemoryEntry.channel` eine Bitmaske ist und
    // `EoDevice.channel` ein 1-basierter Index.
    for (const m of device.memory) {
        push(doc.devices[m.sensorId] || doc.devices[addLocal(m.sensorId, device.baseId)]);
    }

    // Geraete, die DIESEN Sender im Speicher haben
    for (const d of Object.values(doc.devices)) {
        for (const m of d.memory) {
            if (m.sensorId !== device.address) continue;
            if (m.sensorId === device.externalId || d.baseId === device.baseId) push(d);
        }
    }
    return out;
}

function addLocal(sensorId: string, baseId: string): string {
    return a2s((a2i(sensorId) + a2i(baseId)) >>> 0);
}

// -----------------------------------------------------------------------------
// Persistenz gegen /api/eo
// -----------------------------------------------------------------------------

/**
 * Schreibt das Dokument gebuendelt zurueck. Jede Feldaenderung in der Tabelle
 * einzeln zu speichern wuerde den kleinen HTTP-Server mit Requests fluten und
 * bei jedem Tastendruck einen SPIFFS-Write ausloesen; deshalb sammeln wir und
 * schreiben verzoegert. Ein laufender Timer wird dabei neu gestartet.
 */
export class DocumentStore {
    private timer: number | null = null;
    private saving = false;
    private again = false;

    constructor(
        private readonly getDoc: () => EoDocument,
        private readonly onStatus: (text: string, error?: boolean) => void,
        private readonly delayMs = 1200,
    ) {}

    async load(): Promise<EoDocument> {
        const res = await fetch('/api/eo', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return migrateDocument(await res.json());
    }

    /** Speichern anstossen (gebuendelt). */
    schedule(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, this.delayMs);
    }

    /** Sofort speichern (z.B. vor Import/Export oder beim Verlassen). */
    async flush(): Promise<void> {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        // Ein zweiter Aufruf waehrend eines laufenden Uploads wuerde zwei
        // konkurrierende POSTs erzeugen; stattdessen einmal nachziehen.
        if (this.saving) {
            this.again = true;
            return;
        }
        this.saving = true;
        try {
            const res = await fetch('/api/eo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.getDoc()),
            });
            if (!res.ok) {
                const msg = await res.text().catch(() => '');
                this.onStatus(`Speichern fehlgeschlagen (HTTP ${res.status}) ${msg}`.trim(), true);
            } else {
                this.onStatus('gespeichert');
            }
        } catch (e) {
            this.onStatus(`Speichern fehlgeschlagen: ${String(e)}`, true);
        } finally {
            this.saving = false;
            if (this.again) {
                this.again = false;
                await this.flush();
            }
        }
    }

    async clear(): Promise<void> {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const res = await fetch('/api/eo/clear', { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
}
