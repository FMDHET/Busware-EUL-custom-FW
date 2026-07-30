// Erzeugt die Home-Assistant-Konfiguration (YAML) fuer die Eltako-Integration.
//
// Portierung von eo_man/data/ha_config_generator.py. Einrueckung und
// Kommentarzeilen sind bewusst identisch zum Original gehalten, damit von
// EO-Man erzeugte und hier erzeugte Dateien vergleichbar bleiben.

import { a2i, a2s, findByDeviceType, isWiredGatewayType } from './catalog';
import { relatedDevices, type AddField, type EoDevice, type EoDocument } from './model';

/**
 * Offset, auf den bus-gebundene Gateways ihre HA-Sender legen. Bei Funk-
 * Gateways ist es stattdessen deren Base-ID.
 */
export const LOCAL_SENDER_OFFSET_ID = '00-00-B0-00';

/** Felder, die nur der Portal-Pflege dienen und nicht nach HA gehoeren. */
const SKIP_FIELDS = new Set(['comment', 'registered_in']);

export interface HaGatewayOptions {
    /** HA-Gateway-Typ, z.B. "eul_lan". */
    deviceType: string;
    /** Base-ID des Gateways. */
    baseId: string;
    /** Hostname/IP (nur LAN-Gateways). */
    host?: string;
    /** TCP-Port (nur LAN-Gateways). */
    port?: number;
    comment?: string;
}

export interface HaGenerateResult {
    yaml: string;
    /** Geraete, die tatsaechlich exportiert wurden. */
    exported: number;
    /** Warnungen, die den Export nicht verhindern. */
    warnings: string[];
}

// -----------------------------------------------------------------------------
// Validierung (eo_man: perform_tests / test_unique_sender_ids)
// -----------------------------------------------------------------------------

/**
 * Prueft die Sender-IDs der zu exportierenden Geraete. Rueckgabe: Liste der
 * Fehler (leer = alles gut). Doppelte Sender-IDs sind der haeufigste Grund,
 * warum eine erzeugte Konfiguration in HA nicht funktioniert - zwei Aktoren
 * wuerden auf dasselbe Kommando reagieren.
 */
export function validateSenderIds(devices: EoDevice[]): string[] {
    const errors: string[] = [];
    const used = new Map<string, EoDevice>();

    for (const d of devices) {
        const sender = d.additional.sender;
        if (!sender || typeof sender !== 'object') continue;
        const id = String((sender as Record<string, unknown>).id ?? '');
        if (!id) continue;

        const n = parseInt(id, 16);
        if (!Number.isFinite(n) || n < 1 || n > 127) {
            errors.push(`Sender-ID '${id}' von '${d.externalId}' ist keine gültige Zahl zwischen 1 und 127.`);
            continue;
        }
        const other = used.get(id);
        if (other) {
            errors.push(
                `Sender-ID '${id}' ist mehr als einmal vergeben: '${other.externalId}' und '${d.externalId}'.`,
            );
            continue;
        }
        used.set(id, d);
    }
    return errors;
}

// -----------------------------------------------------------------------------
// Generierung
// -----------------------------------------------------------------------------

function header(deviceCount: number, generatedAt: string): string {
    return `
# BESCHREIBUNG:
#
# Automatisch erzeugte Home-Assistant-Konfiguration für die Eltako-Integration
# (https://github.com/grimmpp/home-assistant-eltako).
# Erzeugt am ${generatedAt} vom EUL-Portal (Geräte-Manager), ${deviceCount} Geräte.
#
# Hinweise:
# * Exportiert werden alle Geräte mit 'In HA verwenden' = ja.
# * Die 'id' des Gateways ist frei wählbar - sie muss nur eindeutig sein, wenn
#   du mehrere Gateways einträgst.
# * Sender-IDs werden mit der Base-ID des Gateways verrechnet. Sie müssen im
#   Aktor (PCT14) eingetragen sein, damit HA schalten kann.
#
`;
}

/**
 * Baut den kompletten YAML-Block. `docGateway` beschreibt das Gateway, ueber
 * das HA die Geraete erreicht - beim EUL also dieses Geraet selbst.
 */
export function generateHaConfig(
    doc: EoDocument,
    gateway: HaGatewayOptions,
    generatedAt: string,
): HaGenerateResult {
    const all = Object.values(doc.devices);
    const devices = all.filter((d) => d.useInHa && !isGatewayDevice(d));
    const warnings: string[] = [];

    // Plattformen in stabiler Reihenfolge, damit zwei Exporte desselben
    // Bestands textgleich sind (sonst rauscht jeder Diff).
    const platforms = [...new Set(devices.map((d) => d.haPlatform).filter(Boolean))].sort();

    const withoutPlatform = devices.filter((d) => !d.haPlatform);
    if (withoutPlatform.length) {
        warnings.push(
            `${withoutPlatform.length} Gerät(e) ohne HA-Plattform werden übersprungen: ` +
                withoutPlatform.map((d) => d.externalId).join(', '),
        );
    }
    const withoutEep = devices.filter((d) => d.haPlatform && !d.eep);
    if (withoutEep.length) {
        warnings.push(
            `${withoutEep.length} Gerät(e) ohne EEP exportiert - HA wird sie nicht laden: ` +
                withoutEep.map((d) => d.externalId).join(', '),
        );
    }

    let out = header(devices.length, generatedAt);
    out += '\n';
    out += 'eltako:\n';
    out += '  general_settings:\n';
    out += '    fast_status_change: False\n';
    out += '    show_dev_id_in_dev_name: False\n';
    out += '\n';
    out += '  gateway:\n';
    out += '  - id: 1\n';
    out += `    device_type: ${gateway.deviceType}\n`;
    out += `    base_id: ${gateway.baseId || '00-00-00-00'}\n`;
    if (gateway.comment) out += `    # comment: ${gateway.comment}\n`;
    if (gateway.host) {
        // Die Eltako-Integration erwartet beim EUL den Hostnamen in
        // 'serial_path' (dort steht sonst der Pfad des USB-Sticks).
        out += `    serial_path: ${gateway.host}\n`;
        if (gateway.port) out += `    port: ${gateway.port}\n`;
    }
    out += '    devices:\n';

    let exported = 0;
    for (const platform of platforms) {
        out += `      ${platform}:\n`;
        for (const device of devices) {
            if (device.haPlatform !== platform) continue;
            out += deviceSection(doc, gateway, device) + '\n\n';
            exported++;
        }
    }

    out += '\n';
    out += 'logger:\n';
    out += '  default: info\n';
    out += '  logs:\n';
    out += '    eltako: info\n';

    return { yaml: out, exported, warnings };
}

function isGatewayDevice(d: EoDevice): boolean {
    return !!findByDeviceType(d.deviceType)?.gateway;
}

function deviceSection(doc: EoDocument, gateway: HaGatewayOptions, device: EoDevice): string {
    // Einrueckung wie im Original: Kommentare auf 8, der Listenstrich auf 6.
    const pad = ' '.repeat(8);
    const listPad = ' '.repeat(6);
    let out = '';

    if (device.comment) out += `${pad}# ${device.comment}\n`;

    const related = relatedDevices(doc, device.externalId);
    if (related.length) {
        const list = related
            .map((d) => `${d.name} (Typ: ${d.deviceType || 'unbekannt'}, Adr: ${d.address})`)
            .join(', ');
        out += `${pad}# Verknüpfte Geräte: ${list}\n`;
    }

    const info = findByDeviceType(device.deviceType);
    if (info?.pct14Kf !== undefined && info.pct14Fg !== undefined) {
        out +=
            `${pad}# Sender-ID in PCT14 in Funktionsgruppe ${info.pct14Fg} mit Funktion ` +
            `${info.pct14Kf} eintragen (oder den PCT14-Export im Werkzeuge-Reiter nutzen).\n`;
    }

    // Bei einem Bus-Gateway adressiert HA die Aktoren bus-lokal, sonst
    // weltweit.
    const useLocal = isWiredGatewayType(gateway.deviceType) && gateway.baseId === device.baseId;
    const id = (useLocal ? device.address : device.externalId).trim();

    out += `${listPad}- id: ${id}\n`;
    out += `${listPad}  name: ${device.name}\n`;
    out += `${listPad}  eep: ${device.eep}\n`;
    out += additionalFields(gateway, device.additional, 0);
    return out;
}

function additionalFields(
    gateway: HaGatewayOptions,
    fields: Record<string, AddField>,
    spaceCount: number,
    parentKey?: string,
): string {
    const pad = ' '.repeat(spaceCount + 8);
    let out = '';

    for (const [key, value] of Object.entries(fields)) {
        if (value && typeof value === 'object') {
            out += `${pad}${key}: \n`;
            out += additionalFields(gateway, value as Record<string, AddField>, spaceCount + 2, key);
            continue;
        }
        if (SKIP_FIELDS.has(key)) continue;

        let rendered: string | number | boolean = value;
        if (parentKey === 'sender' && key === 'id') {
            // Die im Portal gepflegte Sender-ID ist nur das letzte Byte; HA
            // braucht die vollstaendige Adresse inklusive Base-ID-Offset.
            const offset = isWiredGatewayType(gateway.deviceType)
                ? LOCAL_SENDER_OFFSET_ID
                : gateway.baseId || '00-00-00-00';
            rendered = a2s((parseInt(String(value).slice(-2), 16) + a2i(offset)) >>> 0);
        }
        if (typeof rendered === 'string' && rendered.includes('?')) {
            rendered += ' # <= MUSS NOCH ERGÄNZT WERDEN!';
        }
        out += `${pad}${key}: ${rendered}\n`;
    }
    return out;
}
