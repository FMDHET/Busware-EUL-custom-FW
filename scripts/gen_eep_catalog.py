#!/usr/bin/env python3
"""EEP-Katalog-Generator fuer das EUL-Portal.

Liest die EnOcean-EEP-Profile aus input/EEP_profiles/ (JSON = Semantik +
Einheiten + Titel, *_test.xml = Bit-Layout + Referenzwerte) und erzeugt daraus
web/src/eep_catalog.ts. Der Katalog wird im Portal-JS clientseitig genutzt, um
die "Bedeutung"-Spalte der Telegramm-Tabelle zu fuellen.

Wichtig: Dies ist ein DEV-Tool. Es laeuft NICHT im PlatformIO-/Firmware-Build.
Nach Aenderungen an den Profilen einmal manuell aufrufen:

    python scripts/gen_eep_catalog.py

Vorgehen:
  * Titel + Telegramm-Klasse (RPS/1BS/4BS/VLD) fuer JEDES Profil -> erlaubt es,
    Lerntelegramme mit dem Profilnamen zu beschriften.
  * Lineare Felder (Temperatur, Feuchte, Beleuchtung, Spannung, ...) werden aus
    den XML-Testvektoren abgeleitet: signifikante (ignoremask==0) Bytes, die
    zwischen Min-/Max-Testfall variieren, ergeben die Bitposition; zwei
    (roh, phys)-Punkte ergeben die lineare Abbildung.
  * VALIDIERUNG: jedes abgeleitete Feld wird gegen ALLE zugehoerigen
    XML-Testpunkte geprueft. Nur Felder, die alle Punkte innerhalb Toleranz
    reproduzieren, landen im Katalog. Nicht ableitbare Felder werden gezaehlt
    und am Ende berichtet (keine stille Truncation).
"""

import glob
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IN_DIR = os.path.join(ROOT, "input", "EEP_profiles")
OUT_TS = os.path.join(ROOT, "web", "src", "eep_catalog.ts")

RORG_CLASS = {0xF6: "RPS", 0xD5: "1BS", 0xA5: "4BS", 0xD2: "VLD",
              0xD1: "MSC", 0xA6: "ADT", 0xD4: "UTE"}

# RealData-Typen, die keine dekodierbaren Nutzfelder sind.
SKIP_TYPES = {"lrn bit", "rorg", "func", "type", "reserved", "lrn", "learn button"}

# --- Deutsche Uebersetzung (Portal ist deutsch) -----------------------------
# Feld-Labels (erscheinen in der "Bedeutung"-Spalte). Nicht Gelistetes bleibt
# englisch (Fallback).
FIELD_DE = {
    "Temperature": "Temperatur",
    "Humidity": "Feuchte",
    "Supply voltage": "Versorgungsspannung",
    "Supply Voltage": "Versorgungsspannung",
    "Supply voltage (OPTIONAL)": "Versorgungsspannung",
    "Supply voltage (REQUIRED)": "Versorgungsspannung",
    "Illumination": "Beleuchtungsstärke",
    "Illumination1": "Beleuchtungsstärke 1",
    "Illumination2": "Beleuchtungsstärke 2",
    "Illuminance": "Beleuchtungsstärke",
    "Set point": "Sollwert",
    "Set Point": "Sollwert",
    "Setpoint": "Sollwert",
    "Basic Setpoint": "Basis-Sollwert",
    "Relative Setpoint": "Relativer Sollwert",
    "Temp Setpoint": "Temperatur-Sollwert",
    "Temperature Set Point": "Temperatur-Sollwert",
    "Illumination Set Point": "Beleuchtungs-Sollwert",
    "Humidity Set Point": "Feuchte-Sollwert",
    "Valve Set point": "Ventil-Sollwert",
    "Concentration": "Konzentration",
    "Meter reading": "Zählerstand",
    "meter reading": "Zählerstand",
    "CO2": "CO₂",
    "VOC": "VOC",
    "Radon": "Radon",
    "Particles_10": "Feinstaub PM10",
    "Temperature from RCU": "Temperatur (RCU)",
    "Dimming Output Level": "Dimmwert",
    "Dimming value": "Dimmwert",
    "Blind/shutter pos.": "Behang-/Rollladenposition",
    "Dawn sensor": "Dämmerungssensor",
    "Wind speed": "Windgeschwindigkeit",
    "Average Wind Speed": "Mittlere Windgeschwindigkeit",
    "Maximum Wind Speed": "Max. Windgeschwindigkeit",
    "Elevation": "Sonnenhöhe",
    "Sun Azimuth": "Sonnen-Azimut",
    "Contact": "Kontakt",
    "Current Value": "Istwert",
    "Actual Value": "Istwert",
    "Actual valve": "Ventil-Iststellung",
    "Current Position": "Position",
    "Valve Position": "Ventilposition",
    "Feed Temperature OR Temperature Set Point": "Vorlauftemperatur / Temp.-Sollwert",
    "Digital value-input": "Digitaleingang",
    "Temporary default": "Temporärer Sollwert",
    "Timeout Setting": "Timeout",
    "Time": "Zeit",
    "Ramping time": "Rampenzeit",
    "Control variable override": "Stellgröße (Override)",
    "Current": "Strom",
}

# Titel: geordnete Term-Ersetzung (laengste zuerst). re scannt links->rechts;
# bei Alternation gewinnt die erste passende Variante an jeder Position und der
# Scan setzt HINTER dem Treffer fort -> kein Doppel-Uebersetzen.
TITLE_TERMS = [
    ("Electronic switches and dimmers with Energy Measurement and Local Control",
     "Elektronische Schalter und Dimmer mit Energiemessung und lokaler Steuerung"),
    ("Detectors - Wind Speed Threshold Detector", "Melder – Windgeschwindigkeits-Schwellenmelder"),
    ("Light Sensor - Curtain Wall Brightness Sensor", "Lichtsensor – Fassaden-Helligkeitssensor"),
    ("Blinds Control for Position and Angle", "Jalousiesteuerung für Position und Winkel"),
    ("Automated Meter Reading (AMR)", "Automatische Zählererfassung (AMR)"),
    ("Battery Powered Actuator", "Batteriebetriebener Stellantrieb"),
    ("Temperature and Humidity Sensor", "Temperatur- und Feuchtesensor"),
    ("Light and Blind Control", "Licht- und Jalousiesteuerung"),
    ("Multisensor Window Handle", "Multisensor-Fenstergriff"),
    ("People Activit Sensor", "Personen-Aktivitätssensor"),
    ("Day/Night Control", "Tag-/Nacht-Steuerung"),
    ("Contacts and Switches", "Kontakte und Schalter"),
    ("Multi Function Sensors", "Multifunktionssensoren"),
    ("Environmental Applications", "Umweltanwendungen"),
    ("LED Controller Status", "LED-Controller-Status"),
    ("Temperature Sensors", "Temperatursensoren"),
    ("Temperature Sensor", "Temperatursensor"),
    ("Room Operating Panel", "Raumbediengerät"),
    ("Multi-Func Sensor", "Multifunktionssensor"),
    ("Barometric Sensor", "Barometrischer Sensor"),
    ("Occupancy Sensor", "Anwesenheitssensor"),
    ("Controller Status", "Controller-Status"),
    ("Mechanical Handle", "Mechanischer Griff"),
    ("Position Switch", "Positionsschalter"),
    ("Central Command", "Zentralkommando"),
    ("Channel number", "Kanalnummer"),
    ("Energy Management", "Energiemanagement"),
    ("HVAC Components", "HLK-Komponenten"),
    ("A.C. Curent Clamp", "AC-Stromzange"),
    ("Power Failure Detection", "Stromausfallerkennung"),
    ("Fan Speed", "Lüfterstufe"),
    ("Occupancy", "Anwesenheit"),
    ("Control", "Steuerung"),
    ("Digital Input", "Digitaleingang"),
    ("Standard Valve", "Standardventil"),
    ("Indoor -Temperature", "Innentemperatur"),
    ("Application Style", "Applikationsstil"),
    ("Sun Intensity", "Sonnenintensität"),
    ("CO2 Sensor", "CO₂-Sensor"),
    ("Gas Sensor", "Gassensor"),
    ("Light Sensor", "Lichtsensor"),
    ("Rocker Switch", "Wippschalter"),
    ("Push Button", "Drucktaster"),
    ("Set Point", "Sollwert"),
    ("Set point", "Sollwert"),
    ("Supply voltage", "Versorgungsspannung"),
    ("Illumination", "Beleuchtungsstärke"),
    ("Temperature", "Temperatur"),
    ("Humidity", "Feuchte"),
    ("Electricity", "Strom"),
    ("Detectors", "Melder"),
    ("Rocker", "Wippe"),
    ("Sensor", "Sensor"),
    ("Range", "Bereich"),
    ("Light", "Licht"),
    ("Universal", "Universal"),
    ("Angle", "Winkel"),
    ("to", "bis"),
    ("and", "und"),
    ("with", "mit"),
    ("for", "für"),
]

_TITLE_ALTS = None
_TITLE_LOOKUP = None


def _build_title_re():
    global _TITLE_ALTS, _TITLE_LOOKUP
    terms = sorted(TITLE_TERMS, key=lambda t: len(t[0]), reverse=True)
    _TITLE_LOOKUP = {en: de for en, de in terms}
    alts = []
    for en, _ in terms:
        if re.fullmatch(r"[A-Za-z0-9 ]+", en):
            alts.append(r"\b" + re.escape(en) + r"\b")
        else:
            alts.append(re.escape(en))
    _TITLE_ALTS = re.compile("|".join(alts))


def title_de(title):
    if _TITLE_ALTS is None:
        _build_title_re()
    return _TITLE_ALTS.sub(lambda m: _TITLE_LOOKUP[m.group(0)], title)


def field_de(label):
    return FIELD_DE.get(label, label)


def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def parse_hex(s):
    s = clean(s)
    m = re.search(r"0x([0-9A-Fa-f]+)", s)
    if m:
        return int(m.group(1), 16)
    try:
        return int(s)
    except ValueError:
        return None


def eep_from_name(path):
    return os.path.basename(path).replace(".json", "")


def load_json_meta(jpath):
    """title, class, und {normalisierter_name: unit} fuer 'from'-Felder."""
    with open(jpath, encoding="utf-8-sig") as f:
        d = json.load(f)
    prof = d.get("profile", {})
    eep = prof.get("eep")
    title = prof.get("title", "")
    rorg = None
    if eep and len(eep) >= 2:
        try:
            rorg = int(eep[0:2], 16)
        except ValueError:
            rorg = None
    units = {}
    for fg in prof.get("functionGroups", []):
        if fg.get("direction") != "from":
            continue
        for fn in fg.get("functions", []):
            key = fn.get("key", "")
            unit = None
            for v in fn.get("values", []):
                rng = v.get("range") or {}
                if rng.get("unit"):
                    unit = rng["unit"]
            if unit:
                units[norm(key)] = unit
                # description-Wort ebenfalls als Alias aufnehmen
                units.setdefault(norm(fn.get("description", "")), unit)
    return eep, title, rorg, units


def extract_bits(payload, start, width):
    """width Bits ab globalem Bit-Offset start (MSB-first) aus payload lesen."""
    val = 0
    for i in range(width):
        p = start + i
        byte_i = p >> 3
        if byte_i >= len(payload):
            return None
        bit = (payload[byte_i] >> (7 - (p & 7))) & 1
        val = (val << 1) | bit
    return val


def parse_xml_points(xpath):
    """Liste von (payload[list[int]], mask[list[int]], {label: raw_str_value})."""
    points = []
    try:
        root = ET.parse(xpath).getroot()
    except Exception:
        return points, None
    eep_el = root.find(".//EEP")
    rorg = parse_hex(eep_el.get("rorg")) if eep_el is not None else None
    for ds in root.findall(".//DataSet"):
        tel = ds.find("Telegram")
        if tel is None:
            continue
        bmax = -1
        raw = {}
        for b in tel.findall("Byte"):
            o = parse_hex(b.get("order"))
            m = parse_hex(b.get("ignoremask"))
            v = parse_hex(b.text)
            if o is None or m is None or v is None:
                continue
            raw[o] = (v, m)
            bmax = max(bmax, o)
        if bmax < 0:
            continue
        payload = [0] * (bmax + 1)
        mask = [0xFF] * (bmax + 1)
        for o, (v, m) in raw.items():
            payload[o] = v
            mask[o] = m
        fields = {}
        for d in ds.findall(".//RealData/Data"):
            typ = clean(d.findtext("Type"))
            sc = clean(d.findtext("Shortcut"))
            val = clean(d.findtext("Value"))
            label = typ or sc
            if not label or norm(label) in {norm(x) for x in SKIP_TYPES}:
                continue
            fields[(label, sc)] = val
        points.append((payload, mask, fields))
    return points, rorg


def derive_linear(points, label, sc):
    """Bitposition + lineare Abbildung fuer ein Feld ableiten und validieren.

    Rueckgabe: dict(k,sb,w,lo,hi) oder None.

    Konvention der EEP-Zertifikats-XML: das gerade getestete Datenbyte hat
    ignoremask==0x00 (voll signifikant), nicht verwandte Bytes 0xFF, Status-
    Bytes (LRN etc.) eine partielle Maske wie 0xF7. Wir werten deshalb nur
    Bytes mit VOLLER Maske 0x00 als Feld-Bytes -> keine Kontamination durch
    das LRN-Bit oder andere Statusbits.
    """
    # Alle numerischen Punkte dieses Feldes sammeln.
    fpts = []
    for payload, mask, fields in points:
        if (label, sc) not in fields:
            continue
        vs = fields[(label, sc)]
        try:
            phys = float(vs)
        except ValueError:
            return None  # nicht-numerisch -> kein lineares Feld
        fpts.append((payload, mask, phys))
    if len(fpts) < 2:
        return None

    nbytes = max(len(p) for p, _, _ in fpts)
    # Feld-Bytes: Byte-Index, der in ALLEN Punkten voll signifikant (mask 0x00)
    # ist UND ueber die Punkte variiert.
    full_sig = [i for i in range(nbytes)
                if all(i < len(m) and m[i] == 0x00 for _, m, _ in fpts)]
    varying = [i for i in full_sig
               if len({p[i] for p, _, _ in fpts if i < len(p)}) > 1]
    if not varying:
        return None
    # Zusammenhaengender Block ab dem kleinsten variierenden Byte.
    start_byte = min(varying)
    end_byte = max(varying)
    if any(i not in full_sig for i in range(start_byte, end_byte + 1)):
        return None  # Luecke -> nicht sauber ableitbar
    start = start_byte * 8
    width = (end_byte - start_byte + 1) * 8

    raws = []
    for payload, _, phys in fpts:
        r = extract_bits(payload, start, width)
        if r is None:
            return None
        raws.append((r, phys))
    if len({r for r, _ in raws}) < 2:
        return None
    # 2-Punkt-Fit aus den Rohwert-Extremen.
    raws.sort()
    (r0, p0), (r1, p1) = raws[0], raws[-1]
    if r1 == r0:
        return None
    slope = (p1 - p0) / (r1 - r0)
    # Validierung gegen ALLE Punkte.
    vspan = max(abs(p) for _, p in raws) or 1.0
    for r, phys in raws:
        est = p0 + (r - r0) * slope
        tol = max(0.02 * vspan, abs(slope) * 1.5, 0.05)
        if abs(est - phys) > tol:
            return None
    return {"sb": start, "w": width, "lo": [r0, p0], "hi": [r1, p1]}


# Versorgungsspannung im 4BS-Bereich ist laut EnOcean-Spec immer 0..5.0 V bzw.
# 0..5.1 V (8 Bit auf DB3). Bei einem Teil der Zertifikats-XMLs steht im
# <Value>-Feld aber der 10-fache Wert (50/51 statt 5.0/5.1) -- vermutlich in
# 0,1-V-Schritten notiert. Der 2-Punkt-Fit uebernimmt das ungeprueft, wodurch
# z.B. A5-08-01 ein FBH55-Telegramm mit DB3=0x93 als 29,4 V statt 2,94 V
# anzeigte. Die Quell-XMLs liegen nicht im Repo (input/ ist gitignored), daher
# korrigieren wir hier nachtraeglich anhand der Spec-Obergrenze.
SUPPLY_V_LABELS = {"Versorgungsspannung", "Supply voltage", "Supply Voltage"}
SUPPLY_V_MAX = 10.0  # V -- alles darueber ist fuer 4BS-SVC physikalisch unmoeglich


def fix_supply_voltage(fld):
    """Zehnerpotenz-Fehler in Versorgungsspannungs-Feldern korrigieren.

    Rueckgabe: True, wenn korrigiert wurde (fuer die Statistik).
    """
    if fld.get("u") != "V" or fld.get("k") not in SUPPLY_V_LABELS:
        return False
    span = max(abs(fld["lo"][1]), abs(fld["hi"][1]))
    if span <= SUPPLY_V_MAX:
        return False
    factor = 1.0
    while span / factor > SUPPLY_V_MAX:
        factor *= 10.0
    fld["lo"][1] = round(fld["lo"][1] / factor, 4)
    fld["hi"][1] = round(fld["hi"][1] / factor, 4)
    return True


def main():
    if not os.path.isdir(IN_DIR):
        print(f"[eep] input dir not found: {IN_DIR}", file=sys.stderr)
        return 1

    jsons = sorted(glob.glob(os.path.join(IN_DIR, "*.json")))
    catalog = {}
    stats = {"profiles": 0, "with_xml": 0, "lin_fields": 0,
             "lin_dropped": 0, "titles": 0, "v_fixed": 0}
    dropped = defaultdict(list)

    for jpath in jsons:
        eep = eep_from_name(jpath)
        try:
            jeep, title, rorg, units = load_json_meta(jpath)
        except Exception as e:
            print(f"[eep] skip {eep}: json error {e}", file=sys.stderr)
            continue
        stats["profiles"] += 1
        entry = {"t": title_de(title), "cls": RORG_CLASS.get(rorg or -1, "")}
        stats["titles"] += 1

        xpath = jpath.replace(".json", "_test.xml")
        if os.path.isfile(xpath):
            stats["with_xml"] += 1
            points, xrorg = parse_xml_points(xpath)
            # Kandidaten-Felder: alle (label, sc) mit numerischen Werten.
            labels = {}
            for _, _, fields in points:
                for (label, sc) in fields:
                    labels.setdefault((label, sc), 0)
                    labels[(label, sc)] += 1
            lin = []
            for (label, sc) in labels:
                fld = derive_linear(points, label, sc)
                if fld:
                    fld["k"] = field_de(label)
                    unit = units.get(norm(label)) or units.get(norm(sc))
                    if unit:
                        fld["u"] = unit
                    if fix_supply_voltage(fld):
                        stats["v_fixed"] += 1
                    lin.append(fld)
                    stats["lin_fields"] += 1
                else:
                    stats["lin_dropped"] += 1
                    dropped[eep].append(label)
            if lin:
                lin.sort(key=lambda f: f["sb"])
                entry["lin"] = lin
        catalog[eep] = entry

    # TS-Datei schreiben.
    os.makedirs(os.path.dirname(OUT_TS), exist_ok=True)
    with open(OUT_TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("// AUTO-GENERATED von scripts/gen_eep_catalog.py - NICHT von Hand editieren.\n")
        f.write("// Quelle: input/EEP_profiles/*.json (+ *_test.xml). Neu erzeugen:\n")
        f.write("//   python scripts/gen_eep_catalog.py\n")
        f.write("//\n")
        f.write("// Lineares Feld: phys = lo[1] + (raw - lo[0]) * (hi[1]-lo[1])/(hi[0]-lo[0])\n")
        f.write("// raw = w Bits ab Bit-Offset sb (MSB-first) aus dem Payload (DB..).\n\n")
        f.write("export interface EepLinField { k: string; u?: string; sb: number; w: number; lo: [number, number]; hi: [number, number]; }\n")
        f.write("export interface EepEntry { t: string; cls: string; lin?: EepLinField[]; }\n\n")
        f.write("export const EEP_CATALOG: Record<string, EepEntry> = ")
        # Kompakt, aber deterministisch (sort_keys) fuer lesbare Diffs.
        f.write(json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        f.write(";\n")

    print(f"[eep] profiles={stats['profiles']} with_xml={stats['with_xml']} "
          f"titles={stats['titles']} lin_fields={stats['lin_fields']} "
          f"lin_dropped={stats['lin_dropped']} v_fixed={stats['v_fixed']}")
    print(f"[eep] wrote {os.path.relpath(OUT_TS, ROOT)} "
          f"({os.path.getsize(OUT_TS)/1024:.1f} KB, {len(catalog)} entries)")
    # Ein paar Beispiele der abgelehnten Felder zeigen (Transparenz).
    shown = 0
    for eep, labs in sorted(dropped.items()):
        if shown >= 12:
            print(f"[eep] ... und weitere {len(dropped)-shown} Profile mit abgelehnten Feldern")
            break
        print(f"[eep]   dropped {eep}: {', '.join(sorted(set(labs)))}")
        shown += 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
