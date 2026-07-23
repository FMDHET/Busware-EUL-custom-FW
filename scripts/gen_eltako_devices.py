#!/usr/bin/env python3
"""Eltako-Funkgeräte-Katalog aus dem EEP-Navigator (Excel) erzeugen.

Liest input/EEP-Navigator-Wer-passt-zu-wem-1.xlsx (Blatt "Sensoren-EEPs") und
schreibt web/src/eltako_devices.ts. Jede Zeile = ein Eltako-Sensor mit
Sensortyp (Funktion) und zugehörigem EEP. Modelle mit mehreren Funktionen
erscheinen mehrfach (z.B. F4USM61B als Bewegungsmelder A5-07-01, FBH A5-08-01,
Taster F6-02-01 ...).

DEV-Tool, läuft NICHT im Firmware-Build. Neu erzeugen nach Excel-Änderung:
    python scripts/gen_eltako_devices.py   (benötigt openpyxl)
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
XLSX = os.path.join(ROOT, "input", "EEP-Navigator-Wer-passt-zu-wem-1.xlsx")
OUT_TS = os.path.join(ROOT, "web", "src", "eltako_devices.ts")
SHEET = "Sensoren-EEPs"

EEP_RE = re.compile(r"([0-9A-Fa-f]{2}-[0-9A-Fa-f]{2}-[0-9A-Fa-f]{2})")

# Manuelle Ergänzungen, die (noch) nicht im Excel stehen. Bleiben bei jeder
# Neugenerierung erhalten und sind versioniert. Format: (Modell, Typ, EEP).
MANUAL_EXTRA = [
    ("FNSN55EB", "Näherungssensor (NanoPower)", "F6-02-01"),  # bestätigt Eltako-Katalog
]


def clean(v):
    return re.sub(r"\s+", " ", str(v)).strip() if v is not None else ""


def norm_eep(*cands):
    """Erstes sauberes RORG-FUNC-TYPE aus den Kandidaten (col6, dann col9)."""
    for c in cands:
        m = EEP_RE.search(clean(c))
        if m:
            return m.group(1).upper()
    return ""


def main():
    try:
        import openpyxl
    except ImportError:
        print("[eltako] openpyxl fehlt: pip install openpyxl", file=sys.stderr)
        return 1
    if not os.path.isfile(XLSX):
        print(f"[eltako] Excel nicht gefunden: {XLSX}", file=sys.stderr)
        return 1

    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb[SHEET]
    rows = list(ws.iter_rows(values_only=True))

    seen = set()
    entries = []          # (model, typ, eep)
    skipped_no_eep = []
    for r in rows[2:]:    # Zeile 0 = EEP-Matrix-Header, Zeile 1 = Spaltentitel
        typ = clean(r[2])
        model = clean(r[3])
        eep = norm_eep(r[6], r[9])
        if not model:
            continue
        if not eep:
            skipped_no_eep.append((model, typ))
            continue
        key = (model, eep, typ)
        if key in seen:
            continue
        seen.add(key)
        entries.append((model, typ, eep))

    # Manuelle Ergänzungen einmischen (nur wenn nicht ohnehin schon vorhanden).
    n_extra = 0
    for model, typ, eep in MANUAL_EXTRA:
        key = (model, eep, typ)
        if key in seen:
            continue
        seen.add(key)
        entries.append((model, typ, eep))
        n_extra += 1

    # Stabil sortieren: nach Modell, dann EEP.
    entries.sort(key=lambda e: (e[0].upper(), e[2]))

    def esc(s):
        return s.replace("\\", "\\\\").replace("'", "\\'")

    with open(OUT_TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("// AUTO-GENERATED von scripts/gen_eltako_devices.py - NICHT von Hand editieren.\n")
        f.write("// Quelle: input/EEP-Navigator-Wer-passt-zu-wem-1.xlsx (Blatt 'Sensoren-EEPs').\n")
        f.write("// Neu erzeugen: python scripts/gen_eltako_devices.py\n")
        f.write("//\n")
        f.write("// Eltako-Funkgeräte (Sender) -> EEP. Modelle mit mehreren Funktionen kommen\n")
        f.write("// mehrfach vor (Feld 'typ' unterscheidet). 'key' ist innerhalb der Liste eindeutig.\n\n")
        f.write("export interface EltakoDevice { key: string; model: string; typ: string; eep: string; }\n\n")
        f.write("export const ELTAKO_DEVICES: EltakoDevice[] = [\n")
        keyseen = {}
        for model, typ, eep in entries:
            base = f"{model}|{eep}"
            key = base
            if key in keyseen:
                keyseen[key] += 1
                key = f"{base}#{keyseen[base]}"
            else:
                keyseen[key] = 1
            f.write(f"    {{ key: '{esc(key)}', model: '{esc(model)}', typ: '{esc(typ)}', eep: '{esc(eep)}' }},\n")
        f.write("];\n")

    eeps = sorted({e[2] for e in entries})
    print(f"[eltako] {len(entries)} Einträge, {len(eeps)} distinct EEPs, "
          f"{len(skipped_no_eep)} Zeilen ohne EEP übersprungen")
    print(f"[eltako] geschrieben: {os.path.relpath(OUT_TS, ROOT)}")
    # Gegen Katalog prüfen (nur Info).
    cat_ts = os.path.join(ROOT, "web", "src", "eep_catalog.ts")
    if os.path.isfile(cat_ts):
        import json
        m = re.search(r"EEP_CATALOG.*?= (\{.*\});", open(cat_ts, encoding="utf-8").read(), re.S)
        cat = json.loads(m.group(1)) if m else {}
        missing = [e for e in eeps if e not in cat]
        if missing:
            print(f"[eltako] EEPs NICHT im Katalog (keine 'Bedeutung'-Dekodierung): {missing}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
