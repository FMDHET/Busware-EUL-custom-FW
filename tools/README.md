# EUL22 Diagnose-Tools

Zwei kleine GUI-Tools (Python 3 / tkinter, **keine Installation noetig**) zum
Pruefen der TCP-Verbindung zum EUL22-Gateway.

Start jeweils per Doppelklick oder:

```
python eul_conn_monitor.py
python eul_load_test.py
```

Default-Host `eul.local`, Port `2325` (der ESP3-TCP-Port des EUL — im Portal
unter **EnOcean** sichtbar/einstellbar). Beide Felder sind in der GUI aenderbar;
alternativ die IP eintragen (z.B. `192.168.177.15`). Ist im EUL ein AUTH-Token
gesetzt, ins Feld **Token** eintragen.

## 1. `eul_conn_monitor.py` — Verbindungs-Monitor
Haelt selbst eine Dauerverbindung zum EUL (wie Home Assistant) und protokolliert
**jeden Abbruch und Wiederaufbau** mit Zeitstempel und Dauer. Zeigt live:
Status (verbunden/getrennt/unerreichbar), Verfuegbarkeit in %, Anzahl Abbrueche,
gesamte und laengste Ausfallzeit. Damit sieht man belastbar, **ob und wann** die
Verbindung wegbricht (z.B. durch das FritzBox-Mesh) — auch wenn das Web-Portal
gerade nicht erreichbar ist. Log per Knopf speicherbar.

Hinweis: ein stiller Link-Abriss (Gerät faellt aus dem Mesh) wird ueber TCP-
Keepalive nach ca. 10–15 s erkannt; ein anschliessender Reconnect-Versuch zeigt
den Ausfall sofort als „unerreichbar".

## 2. `eul_load_test.py` — Verbindungs-/Lasttest
Oeffnet gleichzeitig **X** TCP-Verbindungen zum EUL und zeigt pro Verbindung den
Status (verbunden / abgewiesen / getrennt) inkl. Dauer. Gut, um das Client-Limit
zu testen: der EUL erlaubt werkseitig **max. 4** gleichzeitige Clients
(`EUL_MAX_CLIENTS`) — weitere werden abgewiesen oder wieder geschlossen.
„Alle trennen" schliesst alle Verbindungen wieder.
