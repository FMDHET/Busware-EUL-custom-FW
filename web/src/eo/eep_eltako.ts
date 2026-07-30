// EEP-Profile, die NICHT in der EnOcean-Spezifikation stehen.
//
// `eep_catalog.ts` wird aus den offiziellen EEP-Profilen erzeugt und kennt
// deshalb weder die Eltako-eigenen Profile (M5/G5/H5) noch ein paar Nummern,
// die nur in der Eltako-Geräteliste vorkommen. Ohne sie sind genau die
// Profile nicht auswählbar, die man an einer Baureihe-14-Anlage am
// häufigsten braucht.
//
// Diese Datei wird von Hand gepflegt - sie darf nicht in `eep_catalog.ts`,
// weil `scripts/gen_eep_catalog.py` die Datei bei jedem Lauf überschreibt.
//
// Dekodierung der Eltako-Profile nach der Referenzimplementierung
// grimmpp/eltako14bus (`eltakobus/eep.py`: _EltakoSwitchingCommand,
// _EltakoShutterStatus, _EltakoShutterCommand). Wo dort nur ein Rohwert
// durchgereicht wird, steht hier auch nur der Rohwert - Bedeutungen werden
// nicht erfunden.

import type { EepEntry } from '../eep_catalog';

/** Wertefeld mit fester Bedeutungstabelle (statt linearer Skalierung). */
export interface EepEnumField {
    k: string;
    /** Bit-Offset im Payload, MSB-first (wie bei den linearen Feldern). */
    sb: number;
    w: number;
    /** Rohwert -> Klartext. Fehlt ein Wert, wird die Zahl angezeigt. */
    map?: Record<string, string>;
    u?: string;
}

export interface EltakoEepEntry extends EepEntry {
    enums?: EepEnumField[];
    /**
     * Manche Eltako-Profile senden je nach Telegrammtyp etwas anderes. Diese
     * Variante gilt nur für Nutzdaten dieser Länge (in Byte).
     */
    forLen?: number;
    /** Zweite Variante für die jeweils andere Nutzdatenlänge. */
    alt?: EltakoEepEntry;
    /** Wird im EEP-Prüfer als Fußnote angezeigt. */
    note?: string;
}

export const ELTAKO_EEP_CATALOG: Record<string, EltakoEepEntry> = {
    // --- Eltako-eigene Profile ---------------------------------------------
    'M5-38-08': {
        cls: 'RPS',
        t: 'Eltako: Schaltaktor-Status (Relais, Rückmeldung)',
        // state = (DB0 & 0x20) >> 5  ->  Bit 5, also MSB-Offset 2.
        enums: [{ k: 'Zustand', sb: 2, w: 1, map: { '0': 'Aus', '1': 'Ein' } }],
        note: 'Rückmeldetelegramm der Eltako-Schaltaktoren (FSR14, FSR61, FMZ14 …). '
            + 'Angesteuert werden sie mit A5-38-08.',
    },
    'G5-3F-7F': {
        cls: 'RPS',
        t: 'Eltako: Rollladen-/Jalousie-Status',
        // RPS-Variante: kompletter Zustandsbyte.
        enums: [{ k: 'Zustand (roh)', sb: 0, w: 8 }],
        forLen: 1,
        alt: {
            cls: '4BS',
            t: 'Eltako: Rollladen-/Jalousie-Status (Laufzeit)',
            enums: [
                { k: 'Laufzeit (roh)', sb: 0, w: 16 },
                { k: 'Richtung (roh)', sb: 16, w: 8 },
            ],
            forLen: 4,
        },
        note: 'Sendet je nach Situation ein RPS-Zustandsbyte oder ein 4BS-Telegramm mit '
            + 'Laufzeit und Richtung. Die Zahlenwerte sind gerätespezifisch und in der '
            + 'Referenzimplementierung nicht weiter aufgeschlüsselt.',
    },
    'H5-3F-7F': {
        cls: '4BS',
        t: 'Eltako: Rollladen-/Jalousie-Kommando (Sender)',
        // time = DB2, command = DB1, learn_button = DB0 Bit 3.
        enums: [
            { k: 'Laufzeit (roh)', sb: 8, w: 8 },
            { k: 'Kommando (roh)', sb: 16, w: 8 },
            { k: 'Lerntaste', sb: 28, w: 1, map: { '0': 'gedrückt (Lernen)', '1': 'Datentelegramm' } },
        ],
        note: 'Das EEP, mit dem Home Assistant Eltako-Rollladenaktoren ansteuert.',
    },

    // --- In der Eltako-Geräteliste referenziert, aber nicht im Katalog ------
    // Bewusst ohne Dekodierung: die Feldaufteilung ist nicht belastbar
    // dokumentiert. Auswählbar müssen sie trotzdem sein, sonst lässt sich das
    // Gerät im Portal nicht korrekt beschreiben.
    'A5-13-02': {
        cls: '4BS',
        t: 'Umweltanwendungen, Sonnenintensität (Ergänzung zu A5-13-01)',
        note: 'Keine Dekodierung hinterlegt.',
    },
    'A5-FF-7F': {
        cls: '4BS',
        t: 'Eltako: Direktansteuerung (FMP3)',
        note: 'Keine Dekodierung hinterlegt.',
    },
    'D2-00-01': {
        cls: 'VLD',
        t: 'Eltako: Raumbedienpanel (FMMS44SB)',
        note: 'Keine Dekodierung hinterlegt.',
    },
    'F2-02-01': {
        cls: 'RPS',
        t: 'Eltako: 4-fach-Taster (FTAF55D/FTAF65D)',
        note: 'Keine Dekodierung hinterlegt.',
    },
};

/**
 * Passende Variante wählen: G5-3F-7F liefert je nach Telegrammtyp
 * Unterschiedliches, erkennbar an der Nutzdatenlänge.
 */
export function eltakoVariant(eep: string, payloadLen: number): EltakoEepEntry | null {
    const entry = ELTAKO_EEP_CATALOG[eep];
    if (!entry) return null;
    if (entry.alt && entry.forLen !== undefined && payloadLen !== entry.forLen) {
        return entry.alt;
    }
    return entry;
}
