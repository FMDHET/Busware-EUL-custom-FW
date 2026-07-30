// ESP3-Telegramme bauen und zerlegen.
//
// Gegenstueck zum "Send Message"-Fenster von EO-Man
// (eo_man/view/send_message_window.py). Dort werden ESP2-Telegramme fuer den
// Eltako-Bus erzeugt; der EUL spricht mit dem TCM515 ESP3, deshalb ist der
// Frame-Aufbau hier neu geschrieben - Bedienlogik und Feldaufteilung
// (Typ / Daten / Sender-ID / Status) bleiben dieselben.

export type TelegramType = 'RPS' | '1BS' | '4BS';

/** RORG und Nutzdatenlaenge je Telegrammtyp. */
export const TELEGRAM_TYPES: Record<TelegramType, { rorg: number; dataLen: number; org: string }> = {
    RPS: { rorg: 0xf6, dataLen: 1, org: 'ORG 0x05' },
    '1BS': { rorg: 0xd5, dataLen: 1, org: 'ORG 0x06' },
    '4BS': { rorg: 0xa5, dataLen: 4, org: 'ORG 0x07' },
};

// -----------------------------------------------------------------------------
// CRC8 (Polynom 0x07) - ESP3 nutzt dieselbe Tabelle fuer Header und Daten.
// -----------------------------------------------------------------------------
const CRC8_TABLE: number[] = (() => {
    const t: number[] = [];
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
        t.push(c);
    }
    return t;
})();

export function crc8(bytes: number[]): number {
    let c = 0;
    for (const b of bytes) c = CRC8_TABLE[(c ^ b) & 0xff];
    return c;
}

// -----------------------------------------------------------------------------
// Bauen
// -----------------------------------------------------------------------------

export interface BuildOptions {
    type: TelegramType;
    /** Nutzdaten (1 Byte fuer RPS/1BS, 4 Bytes fuer 4BS). */
    data: number[];
    /** Sender-Adresse, 4 Bytes. */
    senderId: number[];
    status: number;
    /** Wiederholer-Ziel; Default Broadcast. */
    destinationId?: number[];
}

/**
 * Baut einen kompletten ESP3-RADIO_ERP1-Frame (Sync .. CRC8D).
 *
 * Aufbau: 0x55 | DataLen(2, big endian) | OptLen(1) | Type(1) | CRC8H
 *         | RORG | Daten | Sender-ID(4) | Status | Optional(7) | CRC8D
 */
export function buildEsp3Radio(opt: BuildOptions): number[] {
    const spec = TELEGRAM_TYPES[opt.type];
    const data = opt.data.slice(0, spec.dataLen);
    while (data.length < spec.dataLen) data.push(0);

    const sender = opt.senderId.slice(0, 4);
    while (sender.length < 4) sender.push(0);

    const payload = [spec.rorg, ...data, ...sender, opt.status & 0xff];

    // Optionale Daten beim Senden: SubTelNum=3 (vom Datenblatt vorgegeben),
    // Ziel-ID (Broadcast), dBm=0xFF ("egal"), Security-Level=0.
    const dest = (opt.destinationId ?? [0xff, 0xff, 0xff, 0xff]).slice(0, 4);
    const optional = [0x03, ...dest, 0xff, 0x00];

    const header = [
        (payload.length >> 8) & 0xff,
        payload.length & 0xff,
        optional.length & 0xff,
        0x01, // Packet-Type RADIO_ERP1
    ];

    return [0x55, ...header, crc8(header), ...payload, ...optional, crc8([...payload, ...optional])];
}

export function toHexString(bytes: number[], sep = ''): string {
    return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
}

export function parseHexString(s: string): number[] {
    const hex = s.replace(/[^0-9a-fA-F]/g, '');
    const out: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
}

/** "AA-BB-CC-DD" bzw. "AABBCCDD" -> 4 Bytes. Fehlende Stellen werden 0. */
export function parseAddressBytes(s: string): number[] {
    const b = parseHexString(s).slice(0, 4);
    while (b.length < 4) b.unshift(0);
    return b;
}

// -----------------------------------------------------------------------------
// Zerlegen (fuer die farbige Darstellung im Sende-Dialog)
// -----------------------------------------------------------------------------

export type FrameSegmentKind = 'frame' | 'org' | 'data' | 'address' | 'status' | 'crc' | 'optional';

/**
 * Farben der Frame-Abschnitte. Wird sowohl im Sende-Werkzeug als auch in der
 * aufklappbaren Rohframe-Ansicht des Status-Reiters benutzt - dieselbe Farbe
 * bedeutet an beiden Stellen dasselbe Feld.
 */
export const SEGMENT_COLORS: Record<FrameSegmentKind, string> = {
    frame: 'var(--hint)',
    crc: 'var(--hint)',
    org: '#c47f00',
    data: 'var(--danger)',
    address: '#1a7f37',
    status: '#0057b7',
    optional: 'var(--hint)',
};

export interface FrameSegment {
    kind: FrameSegmentKind;
    label: string;
    hex: string;
}

/**
 * Zerlegt einen ESP3-RADIO_ERP1-Frame in benannte Abschnitte. Leeres Array,
 * wenn der Frame zu kurz oder kein RADIO_ERP1 ist.
 */
export function splitFrame(frame: number[]): FrameSegment[] {
    if (frame.length < 8 || frame[0] !== 0x55) return [];
    const dataLen = (frame[1] << 8) | frame[2];
    const optLen = frame[3];
    if (frame[4] !== 0x01) return [];
    if (6 + dataLen + optLen + 1 > frame.length) return [];

    const dataStart = 6;
    const payloadLen = dataLen - 6; // RORG + Sender(4) + Status(1) abziehen
    if (payloadLen < 0) return [];

    const hx = (from: number, to: number) => toHexString(frame.slice(from, to), ' ');

    return [
        { kind: 'frame', label: 'Header', hex: hx(0, 5) },
        { kind: 'crc', label: 'CRC8H', hex: hx(5, 6) },
        { kind: 'org', label: 'RORG', hex: hx(dataStart, dataStart + 1) },
        { kind: 'data', label: 'Daten', hex: hx(dataStart + 1, dataStart + 1 + payloadLen) },
        {
            kind: 'address',
            label: 'Sender-ID',
            hex: hx(dataStart + 1 + payloadLen, dataStart + 5 + payloadLen),
        },
        {
            kind: 'status',
            label: 'Status',
            hex: hx(dataStart + 5 + payloadLen, dataStart + 6 + payloadLen),
        },
        { kind: 'optional', label: 'Optional', hex: hx(dataStart + dataLen, dataStart + dataLen + optLen) },
        {
            kind: 'crc',
            label: 'CRC8D',
            hex: hx(dataStart + dataLen + optLen, dataStart + dataLen + optLen + 1),
        },
    ].filter((s) => s.hex.length > 0) as FrameSegment[];
}

export interface ParsedTelegram {
    rorg: number;
    payload: number[];
    sender: number[];
    status: number;
    /** Empfangsfeldstaerke in dBm, null wenn nicht mitgeliefert. */
    dbm: number | null;
}

/** Liest RORG, Nutzdaten, Sender und Status aus einem ESP3-Frame. */
export function parseEsp3Radio(frame: number[]): ParsedTelegram | null {
    if (frame.length < 8 || frame[0] !== 0x55 || frame[4] !== 0x01) return null;
    const dataLen = (frame[1] << 8) | frame[2];
    const optLen = frame[3];
    if (dataLen < 6 || 6 + dataLen > frame.length) return null;

    const data = frame.slice(6, 6 + dataLen);
    const opt = frame.slice(6 + dataLen, 6 + dataLen + optLen);

    return {
        rorg: data[0],
        payload: data.slice(1, dataLen - 5),
        sender: data.slice(dataLen - 5, dataLen - 1),
        status: data[dataLen - 1],
        // Optional-Byte 5 ist die Feldstaerke, vom TCM als positiver Betrag.
        dbm: opt.length >= 6 ? -opt[5] : null,
    };
}

/** Typ eines RORG zurueckgeben ('' fuer unbekannte). */
export function telegramTypeOf(rorg: number): TelegramType | '' {
    for (const [name, spec] of Object.entries(TELEGRAM_TYPES)) {
        if (spec.rorg === rorg) return name as TelegramType;
    }
    return '';
}
