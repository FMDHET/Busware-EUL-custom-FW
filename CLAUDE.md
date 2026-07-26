# CLAUDE.md — Projekt-Kontext für zukünftige AI-Sessions

Diese Datei bündelt Kontext, den Claude Code (oder andere AI-Assistenten) beim
Wiedereinstieg brauchen. Sie ergänzt README.md um das WARUM/WIE-und-WORAUF-ACHTEN,
das in einer öffentlichen README nichts zu suchen hat.

## Was ist das Projekt

Custom-Firmware für die **Busware EUL** (ESP32-C3 + TCM515 EnOcean-Transceiver).
Ersetzt die Original-Busware-FW durch eine Version mit **WLAN-TCP-Bridge**,
**Web-Portal** und **CRA-/RED-konformem Sicherheitsmodell**. Ziel-User:
Eltako-Kollegen und Home-Assistant-Nutzer, die den EUL als LAN-Gateway
verwenden wollen.

Die Firmware wurde in einer einzigen langen Session iterativ aufgebaut. Kein
Vorgängersystem, kein Legacy-Code — von scratch.

## Kritische Design-Entscheidungen

### Framework: ESP-IDF (kein Arduino Core)
Nach kurzem Abwägen mit User: ESP-IDF gewählt. Grund: das Projekt sollte
skalierbar sein für spätere Features (mehrere Task-Pools, Component-System).
Arduino wäre einfacher gestartet, aber der finale Umfang (SoftAP + HTTP-Portal
+ TCP-Server + USB-Bridge + Rate-Limiting + Console-Log) rechtfertigt IDF.

### TCM515 auf 460800 Baud (nicht 57600)
**Der größte Debug-Blocker der Session.** Der User hat Anfang der Session
bestätigt, dass die Hardware mit Original-FW funktioniert, aber mit unserer FW
sendet der TCM515 keinen einzigen Byte zurück (`tcm_rx_bytes = 0` trotz
sauberem TX).

Rausgefunden durch Analyse des Original-FW-Repos
[tostmann/busware-esp32](https://github.com/tostmann/busware-esp32):
- Datei `Simple/TCPBridge/src/main.ino` Zeile 27:
  `TCMTransceiver Transceiver(&Serial0, 3, 5);`
  Args: `(reset_pin=3, turbo_pin=5)`
- Datei `lib/busware/busware.cpp`:
  ```cpp
  void TCMTransceiver::begin() {
      if (_turboPIN) {
          digitalWrite(_turboPIN, LOW);
          _serial->begin(460800);
      } else
          _serial->begin(57600);
  }
  ```

Busware fährt den TCM515 **im Turbo-Mode**: GPIO 5 wird `LOW` gehalten und die
UART läuft mit **460800 Baud**. Mit dem TCM-Datasheet-Standard 57600 ohne
Turbo-Pin sieht der TCM515 unseren Traffic nur als Rauschen.

Vorher hatte ich (falsch) angenommen:
- Reset auf GPIO 4 (Arduino-Alias „D2" im Schematic)
- 57600 Baud (TCM-Datasheet)
- PROG-Pin auf GPIO 5 (Arduino-Alias „D3")

Alles falsch. Korrekt aus drei-Quellen-Synthese (User-Tasmota-Config +
tostmann-Repo + Schaltplan):
- NRST = GPIO 3
- TURBO = GPIO 5 (aktiv LOW)
- BOOT/PROG = GPIO 10 (nicht getrieben, internes Pull-Up)
- LED = GPIO 9
- Baud = 460800

Alle Details mit Quellen-Referenzen in [board_config.h](main/board_config.h).

### Socket-Leak-Fix in tcp_server
**Der zweite subtile Bug.** Vor dem Fix wurden bei jedem HA-Reconnect
LWIP-Sockets geleakt, weil `close_slot_locked()` mit `if (!c->active) return;`
den Cleanup übersprang, wenn der RX-Task `c->active = false` vor dem TX-Task
gesetzt hatte. Nach ~15 Reconnects war der LWIP-Socket-Pool voll → alle Ports
(HTTP und TCP) haben mit `Connection reset by peer` geantwortet.

Fix (siehe [tcp_server.c](main/tcp_server.c)):
- `cleaned`-Flag im Slot: idempotenter Cleanup, nicht mehr abhängig von
  `active`
- `tx_running`-Flag: RX-Task wartet auf TX-Task-Ende bevor `StreamBuffer`
  gelöscht wird (verhindert Race)
- RX-Task übernimmt Cleanup allein, TX exit'et nur nach `!active`
- `shutdown(SHUT_RDWR)` sprengt blockierendes `send()` auf

### HTTPD-Konfig für Multi-Client-Polling
Das Portal pollt alle 500 ms `/api/console`. Mit HTTPD-Defaults
(`max_open_sockets=7`, kein `lru_purge`, kein Keep-Alive) waren Sockets im
`TIME_WAIT` nach kurzer Zeit erschöpft.

Fix in [http_portal.c](main/http_portal.c):
```c
cfg.max_open_sockets   = 10;
cfg.lru_purge_enable   = true;
cfg.keep_alive_enable  = true;
cfg.keep_alive_idle    = 5;
cfg.recv_wait_timeout  = 5;
cfg.send_wait_timeout  = 5;
```
Und `CONFIG_LWIP_MAX_SOCKETS=20` in `sdkconfig.defaults`.

### Config-Store Robustheits-Refactor
Nach User-Beschwerde („die FW hat die WiFi-Credentials verloren") wurde
`config_store` komplett refaktoriert:
- Feingranulare Setter: `config_save_wifi()`, `config_save_modes()`,
  `config_regen_tcp_token()`, `config_set_admin_pass()` — jeder berührt nur
  seine eigenen NVS-Keys, keine gegenseitige Kontamination mehr möglich
- WiFi-Credentials sind **paarweise**: Server verlangt SSID+PW zusammen
  non-empty oder gar nicht. Portal-JS enforced das clientseitig
- `sanity_check_and_fix()` auf Boot: erkennt `provisioned=1` mit leerer
  SSID/PW und setzt automatisch auf unprovisioniert (recovery in AP-Mode
  statt endloser STA-Retry-Loop)

### TypeScript-Portal-Build
Auf Wunsch des Users wurde die UI in TypeScript umgeschrieben mit echter
Build-Pipeline. Setup:
- `web/src/main.ts` — Frontend-Code mit `interface`-Definitionen die 1:1
  zu den HTTP-Endpoint-Responses passen
- `web/build.mjs` — esbuild bundlet TS zu minified IIFE, inline'd in
  `web/index.html` und schreibt `main/portal_html.h` als C-String
- `scripts/prebuild_web.py` — PlatformIO extra_script triggert das vor
  jedem PIO-Build
- Auge-Icons für Password-Inputs UND readonly Secret-Displays (Tokens,
  Admin-PW). Secret-Displays maskieren mit fester Anzahl Punkte, damit
  Zeichenzahl nicht leakt

Der User hatte kein Node installiert; wir haben `brew install node` gemacht
und dann funktioniert alles ohne weiteres Zutun.

## Build-Workflow

Entwicklungsumgebung ist **Windows 11** mit PlatformIO. Das Repo liegt unter
`c:\Users\falkt\Documents\GitHub\FMDHET\Busware-EUL-custom-FW` — kein
Leerzeichen im Pfad, also kein Shadow-Ordner nötig.

```bash
# aus dem Repo-Root, Git Bash
~/.platformio/penv/Scripts/pio.exe run              # bauen
~/.platformio/penv/Scripts/pio.exe run -t upload    # per USB flashen
```

`idf.py` und `pio` liegen **nicht** im PATH, `~/.platformio/` ist aber
vollständig installiert (ESP-IDF-Framework + RISC-V-Toolchain).

OTA-Update ohne Kabel (Details im [Wiki](https://github.com/FMDHET/Busware-EUL-custom-FW/wiki/Authentifizierung)):
```bash
curl -H "Authorization: Bearer <ota-token>" \
     --data-binary @.pio/build/busware-eul/firmware.bin http://<ip>/api/ota
```

### ⚠️ sdkconfig-Gotcha
Es gibt ein generiertes `sdkconfig.busware-eul` (nicht in git). ESP-IDF-Kconfig
zieht `sdkconfig.defaults` **nur** für Keys, die dort noch nicht stehen. Ein
`CONFIG_*` in `sdkconfig.defaults` zu ändern bleibt also **wirkungslos**,
solange derselbe Key im generierten `sdkconfig.busware-eul` steht — dort
ebenfalls anpassen (oder die Datei löschen und neu erzeugen lassen). Der
effektive Wert steht in `.pio/build/busware-eul/config/sdkconfig.h`.

### Erster Build braucht Downloads
- ESP-IDF-Toolchain (~500 MB)
- `espressif/mdns` Managed Component (~50 KB)
- npm-Deps für Portal (`esbuild` + `typescript`, ~30 MB)

Danach ist alles gecached und Builds gehen unter einer Minute.

## Serial-Debug-Workflow

Die USB-Serial/JTAG-Console des ESP32-C3 re-enumeriert bei jedem Reset. Naives
`cat /dev/cu.usbmodem114201` schlägt fehl (EOF beim Reset).

Bewährte Pattern:
```python
import serial, time
s = serial.Serial('/dev/cu.usbmodem114201', 115200, timeout=0.2)
# DTR toggle -> reset (nutzt USB-Serial/JTAG hardware reset)
s.setDTR(False); s.setRTS(True); time.sleep(0.15)
s.setDTR(True);  s.setRTS(False)
# Sofort lesen, hält Verbindung offen über re-enumeration:
end = time.time() + 12
while time.time() < end:
    d = s.read(4096)
    if d: print(d.decode(errors='replace'), end='', flush=True)
```

Für Reset-Trigger von außen: `pio` bzw. esptool via
```bash
python -c "import esptool; esptool.main([
  '--chip','esp32c3','--port','/dev/cu.usbmodem114201',
  '--after','hard_reset','chip_id'])"
```

Sobald `usb_cdc_gateway` aktiv ist, wird `esp_log` komplett stummgeschaltet
(sonst verunreinigt es den ESP3-Bytestrom).

## Config-Discovery via HTTP-API

Im Normal-Modus lassen sich alle Werte per HTTP mit Basic-Auth abfragen:
```bash
curl -u admin:<pw> http://192.168.x.x/api/state
curl -u admin:<pw> http://192.168.x.x/api/clients
curl -u admin:<pw> http://192.168.x.x/api/stats
curl -u admin:<pw> 'http://192.168.x.x/api/console?since=0'
```

Das Admin-Passwort ist im Provisioning-Modus in den Portal-Logs sichtbar (`printf`) und im NVS unter `admin_pass` gespeichert.

## Bekannte Gotchas

- **GPIO 9 ist BOOT-Strapping-Pin** auf ESP32-C3. Wir nutzen es als LED
  (active-low). Solange wir es zur Laufzeit nutzen (nicht während CPU-Reset),
  kein Problem — der Chip hat internen Pull-Up auf GPIO 9. Aber: NICHT
  während Reset-Sequenzen aktiv LOW halten, sonst geht das Board in
  Download-Mode.

- **HA Eltako-Integration hat kein AUTH-Handshake-Support** in der Standard-
  Version. Wenn Token-Auth genutzt werden soll, braucht es entweder eine
  Custom-Component oder einen `socat`-Wrapper. Deshalb der HA-Preset-Button
  im Portal, der Auth ausschaltet.

- **Portal HTML wird bei jedem PIO-Build regeneriert**. Wenn du in
  `main/portal_html.h` von Hand editierst, wird's beim nächsten `pio run`
  überschrieben. Änderungen gehören in `web/src/main.ts` und
  `web/index.html`.

- **NVS überlebt Reflashes**. Wenn ein Test mit alten NVS-Zuständen
  komisches Verhalten zeigt, im Portal Werksreset klicken oder via esptool
  `erase_flash`.

## Wichtige Files zum Verstehen des Codes

Reihenfolge fürs Onboarding:
1. **[README.md](README.md)** — Feature-Überblick und User-Perspektive
2. **[board_config.h](main/board_config.h)** — Pin-Zuordnungen mit Quellen
3. **[mode_mgr.c](main/mode_mgr.c)** — Was passiert beim Boot
4. **[config_store.h](main/config_store.h)** — API zum NVS
5. **[tcp_server.c](main/tcp_server.c)** — Kern-Bridge-Logik
6. **[http_portal.c](main/http_portal.c)** — Web-Portal-Endpoints
7. **[web/src/main.ts](web/src/main.ts)** — Frontend

## User-Kontext

- **Falk Thumm**, `thumm@eltako.de` — Eltako GmbH, arbeitet an EnOcean-
  Produkten (siehe auch `eltako-knowledge` Skill)
- Nutzt macOS mit Homebrew, PlatformIO im `~/.platformio/penv/`
- Projekte typischerweise unter `/Users/falkthumm/VS Code/` (mit Space —
  siehe Build-Workflow oben)
- Kommunikationsstil: pragmatisch-direkt, deutsche Sprache mit englischen
  Fachbegriffen gemischt
- Präferiert klare Diagnose vor Rate-Fixen — als der TCM515 nicht antwortete
  hat er die Tasmota-Config + tostmann-Link geschickt statt uns weiter im
  Dunkeln stochern zu lassen

## Nicht implementiert (bewusst offen)

- Secure Boot v2 + Flash Encryption (braucht Keys außerhalb Repo)
- App-signierte OTA (Endpoint-Skeleton in http_portal fehlt)
- HTTPS für Portal (mbedTLS-Cert-Handling wäre größere Erweiterung)
- HA-Custom-Component mit AUTH-Handshake-Support (Python)
- `deploy.sh` als CLI-Wrapper um den Shadow-Build-Workflow
- CE/RED-Konformitäts-Dokumentation (Non-Software)

Jedes davon war schon vom User angefragt oder von mir vorgeschlagen worden,
aber bewusst als nächster-Schritt-Kandidat aufgehoben, um den Scope
überschaubar zu halten.
