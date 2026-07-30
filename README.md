# Busware EUL — Custom Firmware

> ## 🔌 Passend für den **[Busware EUL](https://busware.de/tiki-index.php?page=EUL)**
>
> Diese Firmware ist **ausschließlich** für den EnOcean-Stick **EUL** von
> Busware gebaut — ESP32-C3FH4 mit TCM515-Transceiver, USB-C und
> SMA-Antennenanschluss. Auf anderer Hardware läuft sie nicht (feste
> GPIO-Belegung, TCM515-Turbo-Mode).
>
> **Hardware bestellen und Datenblatt:
> <https://busware.de/tiki-index.php?page=EUL>**

Ein WLAN-fähiges EnOcean-Gateway auf Basis der
[Busware-EUL](https://busware.de/tiki-index.php?page=EUL)-Hardware. Verbindet den
TCM515-Transceiver via TCP mit Home Assistant, ESPHome, FHEM oder eigenen Tools
— mit Live-Monitoring-Webportal, Multi-Client-Support und CRA-konformem
Sicherheitsmodell.

## Highlights

- **Multi-Client TCP-Bridge** zum TCM515: bis zu 3 gleichzeitige Verbindungen, RX-Broadcast an alle, TX über Frame-Level-Mutex serialisiert (keine ESP3-Frame-Verschränkung)
- **Optionale USB-CDC-Bridge** parallel zur TCP-Bridge (per Portal umschaltbar)
- **Web-Portal in TypeScript**: WiFi-Setup, Modi-Konfiguration, Live-Verbindungs-Tabelle, TCM-Statistik, Hex-Konsole mit Live-Datenverkehr
- **SoftAP-Provisioning bei Erstboot** mit Captive-Portal (kein Login-Prompt-Sucherei), pro Gerät zufällig generierte Credentials
- **Auth-Handshake für TCP** (Token-basiert) — CRA "secure by default", per Toggle abschaltbar
- **HA-Eltako-Preset**: Ein-Klick-Konfiguration für die [FMDHET/home-assistant-eltako](https://github.com/FMDHET/home-assistant-eltako) Integration (`device_type: eul_lan`)
- **Selbstheilendes NVS**: Sanity-Check beim Boot, feingranulare Setter (WiFi-Update kann Modi nicht mehr korrumpieren)

## Hardware

Zielplattform: **Busware EUL** — ESP32-C3FH4 + TCM515 EnOcean-Transceiver auf einer Platine mit USB-C und SMA-Antennenanschluss.

### GPIO-Belegung

Abgeleitet aus drei Quellen synthetisiert (Tasmota-Template, [tostmann/busware-esp32](https://github.com/tostmann/busware-esp32), Schaltplan). E2E verifiziert mit `CO_RD_VERSION`-Roundtrip.

| Signal | GPIO | Richtung | Bemerkung |
|---|---|---|---|
| UART RX (ESP ← TCM515) | **20** | Input | ESP32.U0RXD (Default-IOMUX), via R6=22 Ω zum TCM515 Pin 21 UART_TX |
| UART TX (ESP → TCM515) | **21** | Output | ESP32.U0TXD (Default-IOMUX), zum TCM515 Pin 20 UART_RX |
| TCM515 NRST | **3** | Output | Active-Low. `LOW` = held-in-reset, `HIGH` = run |
| TCM515 Turbo-Enable | **5** | Output | Muss `LOW` sein für 460800 Baud (Turbo-Mode) |
| TCM515 BOOT/PROG | **10** | Input+PU | Nicht aktiv getrieben. `HIGH` (Pull-Up) = Normal-Mode, `LOW` = Bootloader |
| Status-LED (blau) | **9** | Output | Active-Low (LED gegen VDD via 820 Ω). Achtung: gleichzeitig BOOT-Strap-Pin |

### UART

**460800 Baud, 8N1, kein Flow-Control** — das ist der Busware-Turbo-Mode. Standard-57600 funktioniert dank Auto-Baud-Lock im TCM515 ebenfalls, aber wir bleiben bei der Original-Konvention.

## Quick Start

### Voraussetzungen

- [PlatformIO Core](https://platformio.org/install/cli) (getestet mit Version 6.x, ESP-IDF 5.5.3)
- Node.js ≥ 20 (`brew install node` auf macOS) — für das TypeScript-Portal-Build
- Ein Busware EUL mit USB-C-Kabel

### Build & Flash

```bash
git clone https://github.com/FMDHET/Busware-EUL-custom-FW.git
cd Busware-EUL-custom-FW

# Erster Build zieht ESP-IDF-Toolchain (~500 MB), TypeScript-Deps
# und Managed-Components (mdns). Dauert einmalig ein paar Minuten.
pio run -t upload
```

Der PlatformIO-Extra-Script `scripts/prebuild_web.py` startet automatisch `npm install` + `npm run build` im `web/`-Ordner und schreibt das gebundelte Portal in `main/portal_html.h`. Bei Nicht-Vorhandensein von Node fällt das Skript still zurück auf die eingecheckte `portal_html.h`.

> **Achtung**: ESP-IDF-Builds tolerieren keine Leerzeichen im Projektpfad. Wenn dein Repository z. B. unter `~/VS Code/` liegt, klone in einen Pfad ohne Leerzeichen (`~/vscode/` etc.) oder nutze einen rsync-Shadow-Build.

### Erstboot & Konfiguration

1. Board über USB-C anschließen. Beim ersten Boot geht es in den Provisioning-Modus.
2. Am Handy/Laptop mit dem WLAN `EUL-Config-XXXXXX` verbinden (letzten 6 Zeichen der MAC). Das WPA2-Passwort erscheint auf dem seriellen Log — auch alle 5 s im Provisioning-Beacon:
   ```
   === EUL Provisioning ===
   SoftAP SSID : EUL-Config-D3A768
   SoftAP Pass : DjZd7VpCSGkM
   Portal-URL  : http://192.168.4.1/
   Admin User  : admin
   Admin Pass  : FLbkJnQCUM5Q
   TCP Token   : be299671dccb4d61d382bd81512057dc
   ==========================
   ```
3. Captive-Portal öffnet sich automatisch (sonst `http://192.168.4.1/`).
4. WLAN-Zugang eintragen, TCP/USB-Bridge nach Wunsch aktivieren, **Speichern & Neustart**.
5. Ab jetzt ist das Gerät im Heimnetz unter `eul-gateway-XXXXXX.local` erreichbar (mDNS).

## Home Assistant Integration

Diese Firmware ist kompatibel zur [FMDHET/home-assistant-eltako](https://github.com/FMDHET/home-assistant-eltako) Integration mit `device_type: eul_lan`.

**Empfohlener Setup-Weg**:

1. Im Portal Button **„Preset: HA-Eltako Integration"** klicken → setzt Port 5100, deaktiviert Auth-Handshake, aktiviert TCP-Server
2. **Speichern & Neustart**
3. Das Portal zeigt jetzt einen fertigen YAML-Block, den du in `configuration.yaml` einträgst:

```yaml
eltako:
  gateway:
    - id: 1
      device_type: eul_lan
      serial_path: eul-gateway-D3A768.local
      port: 5100
      base_id: FF-AA-00-00     # base_id des TCM515 anpassen
```

4. HA neu laden → Gerät sollte in wenigen Sekunden verbinden.

**Mit Token-Auth** (empfohlen wenn andere Geräte im Netz stehen): TCP-Auth im Portal aktiviert lassen. Auf HA-Seite braucht es dann eine kleine Wrapper-Komponente, die den `HELLO`/`AUTH <token>`-Handshake vor dem ESP3-Traffic spricht — die Standard-`eltako`-Integration unterstützt das nicht direkt.

## Geräte-Manager

Das Portal enthält einen Geräte-Manager im Stil des Desktop-Tools
[grimmpp/enocean-device-manager](https://github.com/grimmpp/enocean-device-manager) —
direkt im Browser, ohne Python-Installation. Der komplette Datenbestand
(Geräte, Filter, Telegramm-Vorlagen) liegt als **eine JSON-Datei auf dem
Gerät** (SPIFFS, `storage`-Partition) und ist daher aus jedem Browser gleich
sichtbar.

### Reiter „Geräte"

- Jeder empfangene Absender wird automatisch aufgenommen; das EEP wird aus
  A5-Lerntelegrammen gelernt
- Detailformular mit Name, Typ, EEP, Tastenfunktion, Kommentar, HA-Plattform
  und den HA-Zusatzfeldern (`sender`, `device_class`, `time_opens`,
  `meter_tariffs`, `thermostat`, …)
- **Vorschlag aus Katalog** setzt EEP, Plattform und Zusatzfelder anhand des
  Gerätetyps — Katalog aus dem EO-Man-Projekt plus die ~200 Eltako-Funkmodelle
  aus dem EEP-Navigator
- Benannte, speicherbare Filter (global / Adresse / Externe ID / Typ / EEP),
  sortierbare Spalten, Signalstärke und „zuletzt gesehen" je Gerät

### Reiter „Home Assistant"

Erzeugt den kompletten `configuration.yaml`-Block für die Eltako-Integration:
Gateway-Abschnitt, Geräte nach Plattform gruppiert, Sender-IDs mit
Base-ID-Offset verrechnet, verknüpfte Geräte als Kommentar. Vorab wird geprüft,
ob Sender-IDs eindeutig und im gültigen Bereich 1–127 liegen.

### Reiter „Werkzeuge"

| Werkzeug | Zweck |
|---|---|
| **Telegramm senden** | RPS/1BS/4BS bauen, farbig zerlegter ESP3-Frame, Vorlagen, Dauersenden mit Pause/Anzahl (nutzt `/api/send`, braucht die REST-API) |
| **EEP-Prüfer** | Rohdaten nach einem gewählten EEP in physikalische Werte umrechnen |
| **PCT14** | Export einlesen (Adressen, Typen, Beschreibungen, Speicherbelegung einer Baureihe-14-Anlage) bzw. einen Export um die HA-Sender-IDs ergänzen |
| **Gerätekatalog** | Durchsuchbare Liste aller bekannten Typen mit EEP, Plattform und PCT14-Funktionsgruppe |
| **Datenbestand** | Sicherung als JSON herunterladen / einspielen, Speicherbelegung |

> **Kein Bus-Scan.** Das Desktop-Tool liest Geräte über einen FAM14 direkt aus
> dem RS485-Bus. Der EUL hat nur den TCM515-Funktransceiver und keinen
> Bus-Zugang — dieselben Daten kommen hier über den **PCT14-Import**. Ebenso
> entfallen Bus-Burst-Test und die Erkennung fremder ESP2-Gateways.

### HTTP-Endpunkte

Alle drei mit Basic-Auth (wie das übrige Portal), nicht mit dem API-Token:

```bash
curl -u admin:<pw> http://<ip>/api/eo                    # Bestand lesen
curl -u admin:<pw> -X POST --data-binary @backup.json \
     -H 'Content-Type: application/json' http://<ip>/api/eo   # ersetzen (max. 128 KB)
curl -u admin:<pw> -X POST http://<ip>/api/eo/clear      # löschen
```

Geschrieben wird über eine Temp-Datei mit anschließendem `rename` — ein
abgebrochener Upload lässt den alten Bestand unangetastet.

## Sicherheit (CRA / RED)

Was in dieser Firmware bereits umgesetzt ist:

- **Keine statischen Default-Credentials** — SoftAP-Passwort, Portal-Admin-Passwort und TCP-Auth-Token werden bei Werkseinstellungen pro Gerät zufällig generiert und im NVS persistiert
- **Constant-Time-Compare** für alle Auth-Checks
- **„Secure by default"** — TCP-Auth an, USB-Bridge aus
- **Rate-Limiting auf Auth** (5 Fehlversuche/Minute pro IP → 60 s Block)
- **Security-Events** mit `SEC:`-Tag für Audit-Grep
- **Portal-Assets komplett inline** — kein CDN, keine Fremd-Fonts (Datenschutz + lokale Verfügbarkeit)
- **Sanity-Check und Selbstheilung** der NVS-Config bei Boot
- **HTTP-Basic-Auth auf Portal im STA-Modus**, kein Zugriff ohne Login außerhalb des Provisioning-AP

Was noch offen ist (bewusst außerhalb des Software-Scopes):

- **Secure Boot v2 + Flash Encryption** — Setup in [sdkconfig.defaults](sdkconfig.defaults) auskommentiert, braucht Signing-Keys außerhalb des Repos
- **App-signierte OTA-Updates** — Endpoint-Skeleton vorhanden, Signatur-Verifikation TODO
- **HTTPS für das Portal** — bewusster Kompromiss: AP ist per WPA2 geschützt, STA-Portal per Basic-Auth im vertrauten Heimnetz
- **CE/RED-Testberichte** (EMC, Safety) — Hardware-Level
- **Vulnerability-Disclosure-Prozess** — Dokumentation ausstehend

## Architektur

```
                          ┌──────────────────────┐
                          │  Erststart / Reset?  │
                          │  → SoftAP + Portal   │
                          │  konfiguriert → STA  │
                          └──────────┬───────────┘
                                     │
       ┌─────────────────────────────┼─────────────────────────┐
       ▼                                                       ▼
┌──────────────────┐                                ┌────────────────────┐
│ Provisioning     │                                │ Normal             │
│ ──────────────   │                                │ ─────────────────  │
│ SoftAP APSTA     │                                │ WiFi STA + mDNS    │
│ WPA2 pro-Gerät  │                                │ ─────────────────  │
│ Captive DNS      │                                │ TCP-Server         │
│ HTTP-Portal      │                                │  (+ Token-Auth,    │
│ http://192.168.  │                                │     Rate-Limit)    │
│  4.1/            │                                │ USB-CDC (optional) │
└──────────────────┘                                │ HTTP-Portal + Auth │
                                                    └──────────┬─────────┘
                                                               │
                                     ┌─────────────────────────┘
                                     ▼
                          ┌──────────────────────┐
                          │ TCM515 UART @460800  │
                          │ RX → Fan-out         │
                          │ TX ← Mutex, parsed   │
                          └──────────────────────┘
```

### Modul-Übersicht

| Modul | Verantwortung |
|---|---|
| [`main.c`](main/main.c) | LED-Init, Heartbeat-Task, ruft `mode_mgr` |
| [`mode_mgr.c`](main/mode_mgr.c) | Orchestrator: entscheidet Provisioning vs Normal, wirt Netif/Event-Loop, startet Sub-Module |
| [`config_store.c`](main/config_store.c) | NVS-Wrapper mit feingranularen Settern, Sanity-Check |
| [`security.c`](main/security.c) | Random-Passwörter/Tokens (mbedTLS), Constant-Time-Compare, Security-Event-Log |
| [`wifi_sta.c`](main/wifi_sta.c) / [`wifi_ap.c`](main/wifi_ap.c) | WiFi Station / SoftAP Bringup |
| [`captive_dns.c`](main/captive_dns.c) | UDP-DNS-Responder für Captive-Portal-Erkennung |
| [`http_portal.c`](main/http_portal.c) | HTTP-Server + Endpoints + Basic-Auth |
| [`portal_html.h`](main/portal_html.h) | **Auto-generiert** aus `web/` via esbuild |
| [`tcp_server.c`](main/tcp_server.c) | Multi-Client TCP-Server, AUTH-Handshake, Rate-Limit, ESP3-Parser pro Client |
| [`enocean_uart.c`](main/enocean_uart.c) | TCM515-UART-Setup, TX-Mutex, RX-Fanout, Statistik |
| [`esp3_parser.c`](main/esp3_parser.c) | ESP3-Frame-Parser (CRC8H, CRC8D nach EnOcean-Spec) |
| [`usb_cdc_gateway.c`](main/usb_cdc_gateway.c) | USB-Serial/JTAG Bridge zum TCM515 |
| [`console_log.c`](main/console_log.c) | Ring-Buffer für Web-Konsole (Live-Datenverkehr) |
| [`device_store.c`](main/device_store.c) | SPIFFS-Ablage des Geräte-Manager-Dokuments (atomar über Temp-Datei + rename) |
| [`web/src/main.ts`](web/src/main.ts) | Frontend-TypeScript |
| [`web/src/eo/`](web/src/eo/) | Geräte-Manager (Portierung von EO-Man), siehe unten |

Der Geräte-Manager liegt bewusst komplett im Frontend — die Firmware speichert
das Dokument, kennt aber sein Schema nicht und muss bei Modell-Erweiterungen
nicht mitwachsen.

| Modul | Verantwortung |
|---|---|
| [`eo/app.ts`](web/src/eo/app.ts) | Gemeinsamer Zustand + Persistenz-Anbindung (entspricht dem `DataManager`) |
| [`eo/model.ts`](web/src/eo/model.ts) | Datenmodell, Dokument-Migration, gebündeltes Speichern gegen `/api/eo` |
| [`eo/catalog.ts`](web/src/eo/catalog.ts) | Katalog-Lookups, Adressarithmetik, Signalstärke |
| [`eo/catalog_data.ts`](web/src/eo/catalog_data.ts) | **Auto-generiert** via [`scripts/gen_eo_man_data.py`](scripts/gen_eo_man_data.py) |
| [`eo/suggest.ts`](web/src/eo/suggest.ts) | HA-Konfiguration aus dem Katalog vorschlagen |
| [`eo/ha_config.ts`](web/src/eo/ha_config.ts) | YAML-Generator + Sender-ID-Prüfung |
| [`eo/filter.ts`](web/src/eo/filter.ts) | Tabellenfilter |
| [`eo/telegram.ts`](web/src/eo/telegram.ts) | ESP3-Frames bauen/zerlegen (CRC8) |
| [`eo/eep_decode.ts`](web/src/eo/eep_decode.ts) | EEP-Dekodierung, geteilt mit Telegramm-Tabelle und EEP-Prüfer |
| [`eo/pct14.ts`](web/src/eo/pct14.ts) | PCT14-XML lesen und um HA-Sender ergänzen |
| [`eo/ui_devices.ts`](web/src/eo/ui_devices.ts) / [`ui_ha.ts`](web/src/eo/ui_ha.ts) / [`ui_tools.ts`](web/src/eo/ui_tools.ts) | Die drei Reiter |

## Entwicklung

### TypeScript-Portal anpassen

```bash
cd web
npm install    # einmalig
vim src/main.ts

# Nur Typecheck ohne Build:
npm run typecheck

# Manueller Build (schreibt main/portal_html.h):
npm run build

# Oder einfach:
cd ..
pio run    # Prebuild-Skript triggert TS-Build automatisch
```

### Monitor

```bash
pio device monitor -b 115200
```

Im Normalbetrieb ist der serielle Kanal ruhig (nur Info-Logs bei WiFi-/TCP-Events). Im Provisioning-Modus druckt das Board alle 5 s die Credentials.

### Factory-Reset

- Via Portal: **Werkseinstellungen**-Button (löscht NVS, generiert neue Credentials, geht in Provisioning)
- Via TCP: `POST /api/factory-reset` mit Basic-Auth

## Referenzen

- [Busware EUL Produktseite](https://busware.de/tiki-index.php?page=EUL)
- [tostmann/busware-esp32 (Referenz-FW)](https://github.com/tostmann/busware-esp32)
- [FMDHET/home-assistant-eltako](https://github.com/FMDHET/home-assistant-eltako)
- [EnOcean ESP3 Serial Protocol](https://www.enocean.com/en/support/knowledge-base/)
- [ESP32-C3 Technical Reference Manual](https://www.espressif.com/sites/default/files/documentation/esp32-c3_technical_reference_manual_en.pdf)

## Lizenz

Aktuell nicht lizenziert (Standard: alle Rechte vorbehalten). Bei Interesse an Nutzung/Fork bitte Kontakt aufnehmen.
