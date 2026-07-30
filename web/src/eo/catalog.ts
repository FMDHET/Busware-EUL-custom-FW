// Geraete-Katalog und Nachschlage-Helfer.
//
// Portierung von eo_man/data/data_helper.py (EEP_MAPPING + find_*-Funktionen).
// Die Tabellen selbst liegen generiert in catalog_data.ts.

import { DEVICE_CATALOG, KEY_FUNCTIONS, type CatalogEntry } from './catalog_data';
import { ELTAKO_DEVICES } from '../eltako_devices';

export { DEVICE_CATALOG, KEY_FUNCTIONS, ELTAKO_DEVICES };
export type { CatalogEntry };

// -----------------------------------------------------------------------------
// Home-Assistant-Plattformen, die die Eltako-Integration bedient.
// (eo_man/data/const.py: PLATFORMS - die vollstaendige HA-Liste ist fuer die
// Auswahl im Portal nur Rauschen.)
// -----------------------------------------------------------------------------
export const HA_PLATFORMS = [
    'binary_sensor',
    'button',
    'climate',
    'cover',
    'light',
    'sensor',
    'switch',
] as const;

// Gateway-Typen der HA-Eltako-Integration (eo_man: GatewayDeviceType).
// Der EUL meldet sich als 'eul_lan' - so erwartet es die Integration, und so
// erzeugt das Portal den YAML-Block auch schon im EnOcean-Reiter.
export const GATEWAY_TYPES: Array<{ value: string; label: string }> = [
    { value: 'eul_lan', label: 'Busware EUL (dieses Gerät, LAN/ESP3)' },
    { value: 'lan', label: 'LAN Gateway (ESP3)' },
    { value: 'mgw-lan', label: 'PioTek MGW (LAN)' },
    { value: 'esp3-gateway', label: 'ESP3 Gateway (USB)' },
    { value: 'enocean-usb300', label: 'EnOcean USB300' },
    { value: 'fam-usb', label: 'Eltako FAM-USB (ESP2)' },
    { value: 'fam14', label: 'Eltako FAM14 (ESP2, Bus)' },
    { value: 'fgw14usb', label: 'Eltako FGW14-USB (ESP2, Bus)' },
    { value: 'ftd14', label: 'Eltako FTD14 (ESP2, Bus)' },
];

const BUS_GATEWAY_TYPES = new Set(['fam14', 'fgw14usb', 'fgw14', 'ftd14']);

/** true fuer draht-/busgebundene Gateways (FAM14, FGW14-USB, ...). */
export function isWiredGatewayType(deviceType: string | undefined): boolean {
    return !!deviceType && BUS_GATEWAY_TYPES.has(deviceType);
}

/** true, wenn der Geraetetyp ueberhaupt ein Gateway ist. */
export function isGatewayType(deviceType: string | undefined): boolean {
    if (!deviceType) return false;
    if (GATEWAY_TYPES.some((g) => g.value === deviceType)) return true;
    return DEVICE_CATALOG.some((e) => e.gateway && normalizeHwType(e.hw) === normalizeHwType(deviceType));
}

// -----------------------------------------------------------------------------
// Katalog-Lookups
// -----------------------------------------------------------------------------

/**
 * Geraetetyp auf die Vergleichsform bringen: '-' -> '_', gross, und alles ab
 * einem '/' abschneiden ("FSR61/8-24V UC" -> "FSR61").
 * (eo_man: build_unique_name_for_device_type)
 */
export function normalizeHwType(deviceType: string): string {
    let t = deviceType.replace(/-/g, '_').toUpperCase();
    const slash = t.indexOf('/');
    if (slash !== -1) t = t.slice(0, slash);
    return t;
}

/**
 * HA-Plattform aus der Telegrammklasse raten. Der EO-Man-Katalog deckt vor
 * allem Baureihe-14-Aktoren ab; fuer die reinen Funksender aus dem
 * EEP-Navigator gibt es dort keinen Eintrag, ihre Plattform ergibt sich aber
 * eindeutig aus dem RORG (eo_man: ORG_MAPPING).
 */
function platformForEep(eep: string): string {
    const rorg = eep.slice(0, 2).toUpperCase();
    if (rorg === 'F6' || rorg === 'D5') return 'binary_sensor';
    return 'sensor';
}

/**
 * Eltako-Funkgeraet aus dem EEP-Navigator als Katalogeintrag. Ein Modell kann
 * mehrere Funktionen haben (F4USM61B: Taster, Bewegung, Kontakt, ...),
 * deshalb entscheidet bei Bedarf das EEP.
 */
function findEltako(want: string, eep?: string): CatalogEntry | null {
    const hit = ELTAKO_DEVICES.find(
        (d) => normalizeHwType(d.model) === want && (eep === undefined || d.eep === eep),
    );
    if (!hit) return null;
    return {
        hw: hit.model,
        brand: 'Eltako',
        eep: hit.eep,
        platform: platformForEep(hit.eep),
        desc: hit.typ,
        channels: 1,
    };
}

/**
 * Katalogeintrag zum Geraetetyp. Ein Typ kann mehrere EEPs haben (FTS14EM);
 * ohne `eep` gewinnt der erste Treffer, wie im Original. Findet der
 * EO-Man-Katalog nichts, greift die Eltako-Funkgeraeteliste.
 */
export function findByDeviceType(deviceType: string | undefined, eep?: string): CatalogEntry | null {
    if (!deviceType) return null;
    const want = normalizeHwType(deviceType);
    for (const e of DEVICE_CATALOG) {
        if (normalizeHwType(e.hw) !== want) continue;
        if (eep === undefined) return e;
        if (e.eep === eep) return e;
    }
    return findEltako(want, eep);
}

/** Erster Katalogeintrag mit diesem EEP. */
export function findByEep(eep: string | undefined): CatalogEntry | null {
    if (!eep) return null;
    const hit = DEVICE_CATALOG.find((e) => e.eep === eep);
    if (hit) return hit;
    const el = ELTAKO_DEVICES.find((d) => d.eep === eep);
    return el ? findEltako(normalizeHwType(el.model), eep) : null;
}

/** Eltako-Funkgeraete, optional auf eine Telegrammklasse eingeschraenkt. */
export function eltakoModelsFor(rorgPrefix?: string): typeof ELTAKO_DEVICES {
    if (!rorgPrefix) return ELTAKO_DEVICES;
    return ELTAKO_DEVICES.filter((d) => d.eep.slice(0, 2).toUpperCase() === rorgPrefix.toUpperCase());
}

/**
 * true, wenn der Text eine Katalog-Beschreibung ist. EO-Man nutzt das, um
 * einen automatisch gesetzten Kommentar ueberschreiben zu duerfen, einen vom
 * Nutzer getippten aber nicht.
 */
export function isCatalogDescription(text: string | undefined): boolean {
    if (!text) return false;
    return DEVICE_CATALOG.some((e) => e.desc === text);
}

/**
 * Alle bekannten Hardware-Typen, sortiert und ohne Duplikate: Baureihe-14 und
 * Gateways aus dem EO-Man-Katalog plus die Funkgeraete des EEP-Navigators.
 */
export function knownDeviceTypes(): string[] {
    return [
        ...new Set([...DEVICE_CATALOG.map((e) => e.hw), ...ELTAKO_DEVICES.map((d) => d.model)]),
    ].sort();
}

/** Alle Kanaele/Adressen, die ein Geraetetyp belegt (Default 1). */
export function channelCount(deviceType: string | undefined): number {
    return findByDeviceType(deviceType)?.channels || 1;
}

// -----------------------------------------------------------------------------
// PCT14-Tastenfunktionen
// -----------------------------------------------------------------------------

export const KEY_FUNCTION_NAMES: string[] = KEY_FUNCTIONS.map(([name]) => name);

const KEY_FUNC_BY_VALUE = new Map<number, string>(KEY_FUNCTIONS.map(([n, v]) => [v, n]));
const KEY_FUNC_BY_NAME = new Map<string, number>(KEY_FUNCTIONS.map(([n, v]) => [n, v]));

export function keyFunctionName(value: number): string {
    return KEY_FUNC_BY_VALUE.get(value) || 'unknown';
}

export function keyFunctionValue(name: string | undefined): number | null {
    if (!name) return null;
    const v = KEY_FUNC_BY_NAME.get(name);
    return v === undefined ? null : v;
}

/**
 * EEP aus dem Namen einer Tastenfunktion ziehen:
 * "MOTION_DETECTOR_ACCORDING_TO_EEP_A5_07_01" -> "A5-07-01".
 * (eo_man: get_eep_from_key_function_name)
 */
export function eepFromKeyFunctionName(name: string | undefined): string | null {
    if (!name) return null;
    const pos = name.indexOf('EEP_');
    if (pos < 0) return null;
    const raw = name.slice(pos + 4, pos + 4 + 8);
    if (raw.length < 8) return null;
    return raw.replace(/_/g, '-');
}

/**
 * Sprechenden Namen aus der Tastenfunktion ableiten:
 * "MOTION_DETECTOR_ACCORDING_TO_EEP_A5_07_01" -> "Motion Detector".
 * (eo_man: get_name_from_key_function_name)
 */
export function nameFromKeyFunctionName(name: string | undefined): string {
    if (!name) return '';
    const pos = name.indexOf('_ACCORDING_');
    if (pos < 0) return '';
    return name
        .slice(0, pos)
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

// -----------------------------------------------------------------------------
// Adressarithmetik (eo_man: a2s / a2i / add_addresses)
// -----------------------------------------------------------------------------

/** 32-Bit-Zahl -> "AA-BB-CC-DD". */
export function a2s(addr: number, length = 4): string {
    const parts: string[] = [];
    for (let i = length - 1; i >= 0; i--) {
        parts.push(((addr >>> (8 * i)) & 0xff).toString(16).toUpperCase().padStart(2, '0'));
    }
    return parts.join('-');
}

/** "AA-BB-CC-DD" -> 32-Bit-Zahl. Ungueltige Eingabe -> 0. */
export function a2i(addr: string | undefined): number {
    if (!addr) return 0;
    const hex = addr.replace(/[^0-9a-fA-F]/g, '');
    if (!hex) return 0;
    // >>> 0, damit Adressen ab 0x80000000 nicht negativ werden.
    return parseInt(hex, 16) >>> 0;
}

/** Summe zweier Adressen als Adress-String. */
export function addAddresses(a: string, b: string): string {
    return a2s((a2i(a) + a2i(b)) >>> 0);
}

/** true fuer Adressen der Form 00-00-00-xx (bus-lokale Adresse). */
export function isLocalBusAddress(addr: string | undefined): boolean {
    return !!addr && addr.toUpperCase().startsWith('00-00-00-');
}

// -----------------------------------------------------------------------------
// Signalstaerke (eo_man: rssi_quality / rssi_bar / format_rssi)
// -----------------------------------------------------------------------------

export function rssiQuality(dbm: number | null | undefined): string {
    if (dbm === null || dbm === undefined) return '';
    if (dbm >= -60) return 'sehr gut';
    if (dbm >= -75) return 'gut';
    if (dbm >= -90) return 'mittel';
    return 'schwach';
}

export function rssiBar(dbm: number | null | undefined): string {
    if (dbm === null || dbm === undefined) return '';
    const level = { 'sehr gut': 4, gut: 3, mittel: 2, schwach: 1 }[rssiQuality(dbm)] || 1;
    return '▮'.repeat(level) + '▯'.repeat(4 - level);
}

export function formatRssi(dbm: number | null | undefined, withBar = true): string {
    if (dbm === null || dbm === undefined) return '';
    return `${dbm} dBm${withBar ? ' ' + rssiBar(dbm) : ''} (${rssiQuality(dbm)})`;
}
