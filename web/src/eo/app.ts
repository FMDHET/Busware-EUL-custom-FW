// Gemeinsamer Zustand der Geraete-Manager-Reiter.
//
// Entspricht dem DataManager von EO-Man (eo_man/data/data_manager.py): haelt
// den Bestand, verteilt Aenderungen an die Ansichten und kuemmert sich um die
// Persistenz. Die Ereignisverteilung von dort (AppBus) ist hier auf einfache
// Listener-Listen eingedampft - es gibt nur drei Ansichten.

import { DocumentStore, emptyDocument, newDevice, type EoDevice, type EoDocument } from './model';
import { UNKNOWN_PREFIX, describeNewDevice } from './suggest';

export interface EoContext {
    /** Statuszeile des Portals. */
    say(text: string): void;
    /** Hostname, unter dem das Portal gerade erreicht wird. */
    host(): string;
    /** Aktuell eingestellter TCP-Port der Bridge. */
    tcpPort(): number;
    /** Geraete-Token fuer /api/send ('' wenn REST-API aus). */
    apiToken(): string;
}

type Listener = () => void;

class EoApp {
    doc: EoDocument = emptyDocument();
    ctx: EoContext = {
        say: () => {},
        host: () => location.host,
        tcpPort: () => 5100,
        apiToken: () => '',
    };
    store: DocumentStore | null = null;
    /** true, sobald /api/eo geantwortet hat. Vorher nichts zurueckschreiben. */
    loaded = false;

    private deviceListeners: Listener[] = [];

    onDevicesChanged(fn: Listener): void {
        this.deviceListeners.push(fn);
    }

    /** Ansichten neu zeichnen und (verzoegert) speichern. */
    touch(save = true): void {
        for (const fn of this.deviceListeners) fn();
        if (save && this.loaded) this.store?.schedule();
    }

    async init(ctx: EoContext): Promise<void> {
        this.ctx = ctx;
        this.store = new DocumentStore(
            () => this.doc,
            (text, error) => ctx.say(error ? `Geräte-Manager: ${text}` : `Geräte-Manager ${text}`),
        );
        try {
            this.doc = await this.store.load();
        } catch (e) {
            // Kein Grund die Oberflaeche zu blockieren: mit leerem Bestand
            // weiterarbeiten, aber NICHT speichern - sonst ueberschreibt ein
            // voruebergehender Lesefehler den echten Bestand mit nichts.
            ctx.say(`Geräte-Manager: Laden fehlgeschlagen (${String(e)}) - nur lesend`);
            this.doc = emptyDocument();
            this.touch(false);
            return;
        }
        this.loaded = true;
        this.touch(false);
    }

    devices(): EoDevice[] {
        return Object.values(this.doc.devices);
    }

    get(externalId: string): EoDevice | undefined {
        return this.doc.devices[externalId];
    }

    /**
     * Geraet aus einem empfangenen Telegramm nachtragen bzw. dessen
     * Laufzeitwerte auffrischen. Gegenstueck zu
     * DataManager._serial_callback_handler.
     */
    noteTelegram(sender: string, rorg: number, dbm: number | null, epochMs: number): EoDevice {
        let d = this.doc.devices[sender];
        let created = false;
        if (!d) {
            d = newDevice({ address: sender, externalId: sender, rorg });
            describeNewDevice(d);
            this.doc.devices[sender] = d;
            created = true;
        }
        d.rorg = rorg || d.rorg;
        d.rssi = dbm;
        d.lastSeen = epochMs;
        d.telegrams++;
        // Nur eine neue Zeile rechtfertigt das Neuzeichnen der Tabelle; sonst
        // wuerde jedes Telegramm die Auswahl und offene Eingabefelder stoeren.
        if (created) this.touch();
        return d;
    }

    /** EEP aus einem Lerntelegramm uebernehmen, falls noch keines gesetzt ist. */
    learnEep(sender: string, eep: string): void {
        const d = this.doc.devices[sender];
        if (!d || d.eep === eep) return;
        if (d.eep) return; // manuell gesetztes EEP nicht überschreiben
        d.eep = eep;
        describeNewDevice(d);
        this.touch();
    }

    eepFor(sender: string): string {
        return this.doc.devices[sender]?.eep || '';
    }

    nameFor(sender: string): string {
        const n = this.doc.devices[sender]?.name || '';
        // Der automatisch vergebene Platzhalter ist in der Telegrammliste
        // nur Laerm - dort steht die Adresse ohnehin daneben.
        return n.startsWith(UNKNOWN_PREFIX) ? '' : n;
    }

    remove(externalId: string): void {
        delete this.doc.devices[externalId];
        this.touch();
    }
}

export const eoApp = new EoApp();
