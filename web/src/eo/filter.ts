// Tabellenfilter des Geraete-Managers.
//
// Portierung von eo_man/data/filter.py (DataFilter). Semantik unveraendert:
// ein Geraet wird angezeigt, wenn IRGENDEIN Filterbegriff als Teilstring in
// dem jeweils zugeordneten Feld vorkommt (ODER-Verknuepfung, case-insensitiv).

import type { AddField, EoDevice, EoFilter } from './model';

export function emptyFilter(name = ''): EoFilter {
    return { name, global: [], address: [], externalAddress: [], deviceType: [], eep: [] };
}

/** true, wenn der Filter keinerlei Kriterium enthaelt (= alles anzeigen). */
export function isEmptyFilter(f: EoFilter | null | undefined): boolean {
    if (!f) return true;
    return (
        !f.global.length &&
        !f.address.length &&
        !f.externalAddress.length &&
        !f.deviceType.length &&
        !f.eep.length
    );
}

/** Kommagetrennte Eingabe in eine Begriffsliste zerlegen. */
export function splitTerms(raw: string): string[] {
    return raw
        .replace(/;/g, ',')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function matchesAny(terms: string[], value: string | undefined): boolean {
    if (!value) return false;
    const upper = value.toUpperCase();
    return terms.some((t) => upper.includes(t.toUpperCase()));
}

function matchesDict(fields: Record<string, AddField>, terms: string[]): boolean {
    for (const value of Object.values(fields)) {
        if (value && typeof value === 'object') {
            if (matchesDict(value as Record<string, AddField>, terms)) return true;
        } else if (matchesAny(terms, String(value))) {
            return true;
        }
    }
    return false;
}

/** true, wenn das Geraet vom Filter durchgelassen wird. */
export function deviceMatchesFilter(device: EoDevice, filter: EoFilter | null): boolean {
    if (isEmptyFilter(filter)) return true;
    const f = filter as EoFilter;

    if (matchesAny([...f.address, ...f.global], device.address)) return true;
    if (matchesAny([...f.externalAddress, ...f.global], device.externalId)) return true;
    if (matchesAny([...f.deviceType, ...f.global], device.deviceType)) return true;
    if (matchesAny([...f.eep, ...f.global], device.eep)) return true;

    // Der globale Filter greift zusaetzlich auf alle uebrigen Textfelder.
    if (f.global.length) {
        if (matchesAny(f.global, device.keyFunction)) return true;
        if (matchesAny(f.global, device.comment)) return true;
        if (matchesAny(f.global, device.version)) return true;
        if (matchesAny(f.global, device.haPlatform)) return true;
        if (matchesAny(f.global, device.name)) return true;
        if (matchesDict(device.additional, f.global)) return true;
    }
    return false;
}
