// EEP-Dekodierung: aus Nutzdaten lesbare Werte machen.
//
// Basis fuer die Telegramm-Tabelle, die Geraeteliste und den EEP-Checker
// (eo_man: view/eep_checker_window.py + data_helper.get_values_for_eep).

import { EEP_CATALOG } from '../eep_catalog';

export interface DecodedValue {
    label: string;
    value: string;
    unit?: string;
}

/** w Bits ab globalem Bit-Offset sb (MSB-first) aus dem Payload lesen. */
export function extractBits(payload: number[], sb: number, w: number): number | null {
    let val = 0;
    for (let i = 0; i < w; i++) {
        const p = sb + i;
        const bi = p >> 3;
        if (bi >= payload.length) return null;
        val = (val << 1) | ((payload[bi] >> (7 - (p & 7))) & 1);
    }
    return val >>> 0;
}

/** Zahl fuer die Anzeige runden (max. 2 Nachkommastellen, keine End-Nullen). */
export function fmtNum(x: number): string {
    return (Math.round(x * 100) / 100).toString();
}

/**
 * Alle linearen Felder eines EEP aus dem Payload lesen. Leeres Array, wenn das
 * EEP unbekannt ist oder keine dekodierbaren Felder hat (viele VLD-Profile).
 */
export function decodeEepValues(eep: string, payload: number[]): DecodedValue[] {
    const entry = EEP_CATALOG[eep];
    if (!entry || !entry.lin) return [];
    const out: DecodedValue[] = [];
    for (const f of entry.lin) {
        const raw = extractBits(payload, f.sb, f.w);
        if (raw === null) continue;
        const [r0, p0] = f.lo;
        const [r1, p1] = f.hi;
        if (r1 === r0) continue;
        const phys = p0 + ((raw - r0) * (p1 - p0)) / (r1 - r0);
        out.push({ label: f.k, value: fmtNum(phys), unit: f.u });
    }
    return out;
}

/** Kurzform der EEP-Dekodierung fuer eine Tabellenzelle. */
export function decodeByEep(eep: string, payload: number[]): string {
    return decodeEepValues(eep, payload)
        .map((v) => `${v.label} ${v.value}${v.unit ? ' ' + v.unit : ''}`)
        .join(' · ');
}

/** Klartext des EEP aus dem Katalog ('' wenn unbekannt). */
export function eepTitle(eep: string): string {
    return EEP_CATALOG[eep]?.t || '';
}

// -----------------------------------------------------------------------------
// EEP-freie Fallback-Deutung
// -----------------------------------------------------------------------------

export const RPS_BUTTONS = [
    'Wippe A unten', 'Wippe A oben', 'Wippe B unten', 'Wippe B oben',
    'Taste 5', 'Taste 6', 'Taste 7', 'Taste 8',
];

/**
 * RPS (RORG F6): Schalter/Wippe. Status-Bit 5 (0x20) ist T21 und bei
 * PTM-Wippen immer gesetzt; ohne T21 ist die Wippen-Zuordnung nicht belastbar,
 * dann wird nur grob gedeutet. DB0-Bit EB (0x10) = Energiebogen
 * gedrueckt/losgelassen.
 */
export function describeRps(db0: number, status: number): string {
    const eb = (db0 & 0x10) !== 0;
    if ((status & 0x20) === 0) return eb ? 'Taste(n) gedrückt' : 'losgelassen';
    if (!eb && db0 === 0x00) return 'losgelassen';
    let s = `${RPS_BUTTONS[(db0 >> 5) & 0x07]} ${eb ? 'gedrückt' : 'losgelassen'}`;
    if (db0 & 0x01) s += ` + ${RPS_BUTTONS[(db0 >> 1) & 0x07]}`; // zweite Aktion
    return s;
}

/** 1BS (RORG D5): einfacher Kontakt (z.B. Fenster/Tuer). */
export function describe1bs(db0: number): string {
    return db0 & 0x01 ? 'Kontakt geschlossen' : 'Kontakt offen';
}

/**
 * 4BS (RORG A5) generischer Fallback: A5-38-08 Zentralkommando (was dieses
 * Gateway schaltet). d = [DB3, DB2, DB1, DB0]; DB0-Bit 0x08 = Datentelegramm.
 */
export function describe4bs(d: number[]): string {
    if (d.length !== 4) return '';
    const db3 = d[0], db2 = d[1], db0 = d[3];
    if ((db0 & 0x08) === 0) return 'Lerntelegramm';
    if (db3 === 0x01) return db0 & 0x01 ? 'Einschalten' : 'Ausschalten';
    if (db3 === 0x02) return `Dimmen auf ${db2}%${db0 & 0x01 ? '' : ' (aus)'}`;
    return '';
}

export function hex2(n: number): string {
    return n.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * A5-Lerntelegramm mit EEP auswerten: DB0-Bit3 (0x08)=0 -> Lernen,
 * DB0-Bit7 (0x80)=1 -> EEP (FUNC/TYPE) enthalten. Liefert "A5-FF-TT" oder null.
 */
export function eepFromTeachIn4bs(d: number[]): string | null {
    if (d.length !== 4) return null;
    const db3 = d[0], db2 = d[1], db0 = d[3];
    if ((db0 & 0x08) !== 0) return null; // Datentelegramm
    if ((db0 & 0x80) === 0) return null; // Lernen ohne EEP -> FUNC/TYPE unbekannt
    const func = db3 >> 2;
    const type = ((db3 & 0x03) << 5) | (db2 >> 3);
    return `A5-${hex2(func)}-${hex2(type)}`;
}

/**
 * Beste verfuegbare Deutung eines Telegramms: zugeordnetes EEP schlaegt den
 * generischen Fallback. `eep` leer lassen, wenn nichts zugeordnet ist.
 */
export function describeTelegram(
    rorg: number,
    payload: number[],
    status: number,
    eep: string,
): string {
    if (eep) {
        const dec = decodeByEep(eep, payload);
        if (dec) return dec;
    }
    if (rorg === 0xf6) return describeRps(payload[0] ?? 0, status);
    if (rorg === 0xd5) return describe1bs(payload[0] ?? 0);
    if (rorg === 0xa5) return describe4bs(payload);
    return '';
}

/** RORG-Klasse (RPS/1BS/4BS/VLD) direkt aus dem EEP-String. */
export const RORG_NAMES: Record<number, string> = {
    0xf6: 'RPS',
    0xd5: '1BS',
    0xa5: '4BS',
    0xd2: 'VLD',
};

export function eepClass(eep: string): string {
    return RORG_NAMES[parseInt(eep.slice(0, 2), 16)] || '';
}

/** Alle EEPs des Katalogs, optional auf eine RORG-Klasse eingeschraenkt. */
export function eepNames(cls?: string): string[] {
    return Object.keys(EEP_CATALOG)
        .filter((k) => !cls || EEP_CATALOG[k].cls === cls)
        .sort();
}
