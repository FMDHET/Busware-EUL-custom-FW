// Automatischer Vorschlag der Home-Assistant-Konfiguration eines Geraets.
//
// Portierung von Device.set_suggest_ha_config (eo_man/data/device.py).

import { a2i, a2s, findByDeviceType, findByEep, isCatalogDescription, keyFunctionValue } from './catalog';
import type { EoDevice } from './model';

/** EEPs, bei denen HA einen Zaehler-Tarif braucht. */
const METER_EEPS = new Set(['A5-12-01', 'A5-12-02', 'A5-12-03']);

/**
 * Tastenfunktionen, die einen Raumthermostat beschreiben. EO-Man findet den
 * Thermostat ueber die PCT14-Funktionsgruppe 1; die haben wir nach einem
 * PCT14-Import nicht (das Exportformat fuehrt sie nicht mit), deshalb hier
 * ueber die Tastenfunktion - dasselbe Ergebnis, andere Quelle.
 */
const THERMOSTAT_KEY_FUNCTIONS = [
    'TEMPERATURE_CONTROLLER_WITH_SETPOINT',
    'TEMPERATURE_CONTROLLER_WITHOUT_SLIDE_SWITCH',
    'TEMPERATURE_CONTROLLER_WITH_SLIDE_SWITCH_SUN_MOON',
    'TEMPERATURE_CONTROLLER_ACCORDING_EEP_A5_10_06_FTR55D',
    'TEMPERATURE_CONTROLLER_SETPOINT',
]
    .map(keyFunctionValue)
    .filter((v): v is number => v !== null);

const CLEAR_ON_NON_COVER = ['device_class', 'time_closes', 'time_opens'];
const CLEAR_ON_NON_CLIMATE = [
    'temperature_unit',
    'min_target_temperature',
    'max_target_temperature',
    'thermostat',
];

/**
 * Setzt EEP, Plattform und Zusatzfelder aus dem Katalog. Bereits gepflegte
 * Werte werden ueberschrieben - die Funktion ist bewusst der "Zuruecksetzen
 * auf Vorschlag"-Knopf, kein sanftes Auffuellen.
 *
 * Abweichung vom Original: findet sich kein Katalogeintrag, bleibt `useInHa`
 * unangetastet. EO-Man setzt es dort auf true, was Geraete ohne EEP in den
 * Export spuelt und dort `eep:` leer laesst.
 */
export function suggestHaConfig(device: EoDevice, forceUseInHa = false): void {
    const info =
        device.deviceType && device.deviceType !== 'unknown'
            ? findByDeviceType(device.deviceType, device.eep || undefined) ||
              findByDeviceType(device.deviceType)
            : findByEep(device.eep);

    if (!info) {
        if (forceUseInHa) device.useInHa = true;
        return;
    }

    device.useInHa = true;
    if (info.platform) device.haPlatform = info.platform;
    if (info.eep) device.eep = info.eep;
    // Kommentar nur ueberschreiben, wenn er leer ist oder selbst aus dem
    // Katalog stammt - von Hand getippte Notizen bleiben stehen.
    if (info.desc && (!device.comment || isCatalogDescription(device.comment))) {
        device.comment = info.desc;
    }

    // --- Sender (nur Aktoren: HA muss ihnen etwas schicken koennen) ---------
    if (info.senderEep) {
        device.additional.sender = {
            // Sender-IDs muessen im Bereich 1..127 liegen; die Geraeteadresse
            // modulo 128 gibt einen stabilen, meist kollisionsfreien Vorschlag.
            id: a2s(a2i(device.address) % 128).slice(-2),
            eep: info.senderEep,
        };
    } else {
        delete device.additional.sender;
    }

    // --- Rollladen ----------------------------------------------------------
    if (info.platform === 'cover') {
        device.additional.device_class = 'shutter';
        device.additional.time_closes = 25;
        device.additional.time_opens = 25;
    } else {
        for (const k of CLEAR_ON_NON_COVER) delete device.additional[k];
    }

    // --- Heizen/Kuehlen -----------------------------------------------------
    if (info.platform === 'climate') {
        device.additional.temperature_unit = "'K'";
        device.additional.min_target_temperature = 16;
        device.additional.max_target_temperature = 25;

        // `memory` ist beim Import bereits auf den Kanal dieses Geraets
        // gefiltert (entry_channel ist eine Bitmaske, kein Kanalindex).
        const thermostat = device.memory.find((m) => THERMOSTAT_KEY_FUNCTIONS.includes(m.keyFunc));
        if (thermostat) {
            device.additional.thermostat = { id: thermostat.sensorId, eep: 'A5-10-06' };
        } else {
            delete device.additional.thermostat;
        }
    } else {
        for (const k of CLEAR_ON_NON_CLIMATE) delete device.additional[k];
    }

    // --- Zaehler ------------------------------------------------------------
    if (info.meterTariffs) {
        device.additional.meter_tariffs = info.meterTariffs;
    } else if (METER_EEPS.has(device.eep)) {
        device.additional.meter_tariffs = '[1]';
    } else {
        delete device.additional.meter_tariffs;
    }
}

/**
 * Vorschlag fuer ein per Funk neu entdecktes Geraet: Name und Kommentar
 * moeglichst sprechend, damit die Tabelle nicht nur aus Adressen besteht.
 */
export function describeNewDevice(device: EoDevice): void {
    // Der Platzhalter darf ueberschrieben werden, sobald ein Lerntelegramm das
    // EEP nachliefert - ein selbst vergebener Name aber nie.
    if (!device.name || device.name.startsWith(UNKNOWN_PREFIX)) {
        const info = findByEep(device.eep);
        device.name = info ? `${info.hw} ${device.externalId}` : `${UNKNOWN_PREFIX}${device.externalId}`;
    }
    suggestHaConfig(device);
}

/** Prefix des automatisch vergebenen Namens (siehe describeNewDevice). */
export const UNKNOWN_PREFIX = 'Unbekannt ';
