#!/usr/bin/env python3
"""Generiert web/src/eo/catalog_data.ts aus den Upstream-Quellen von EO-Man.

Quellen (werden bei Bedarf nach --workdir geklont):
  * https://github.com/grimmpp/enocean-device-manager
      -> eo_man/data/data_helper.py   : EEP_MAPPING (Geraete-Katalog)
      -> eo_man/data/const.py         : GatewayDeviceType
  * https://github.com/grimmpp/eltako14bus
      -> eltakobus/device.py          : KeyFunction (PCT14-Tastenfunktionen)

Aufruf:
    python scripts/gen_eo_man_data.py [--workdir /tmp/eo-src]

Das Ergebnis wird eingecheckt; der Firmware-Build braucht dieses Skript nicht.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(REPO_ROOT, "web", "src", "eo", "catalog_data.ts")

SOURCES = {
    "eo_man": "https://github.com/grimmpp/enocean-device-manager.git",
    "eltakobus": "https://github.com/grimmpp/eltako14bus.git",
}


def ensure_sources(workdir: str) -> dict[str, str]:
    os.makedirs(workdir, exist_ok=True)
    paths = {}
    for name, url in SOURCES.items():
        dest = os.path.join(workdir, name)
        if not os.path.isdir(os.path.join(dest, ".git")):
            print(f"[gen] clone {url}")
            subprocess.run(["git", "clone", "--depth", "1", url, dest], check=True)
        paths[name] = dest
    return paths


# -----------------------------------------------------------------------------
# EEP_MAPPING -> DEVICE_CATALOG
#
# data_helper.py laesst sich nicht importieren (haengt an homeassistant +
# eltakobus). Wir schneiden das Literal heraus und werten es mit ast aus,
# nachdem die CONF_*-Konstanten durch ihre String-Werte ersetzt wurden.
# -----------------------------------------------------------------------------

# Aus eo_man/data/const.py bzw. homeassistant.const - die Namen, die als
# dict-Keys/Values in EEP_MAPPING vorkommen.
CONST_SUBST = {
    "CONF_EEP": '"eep"',
    "CONF_TYPE": '"platform"',
    "CONF_NAME": '"name"',
    "CONF_METER_TARIFFS": '"meter_tariffs"',
    "Platform.BINARY_SENSOR": '"binary_sensor"',
    "Platform.SENSOR": '"sensor"',
    "Platform.LIGHT": '"light"',
    "Platform.SWITCH": '"switch"',
    "Platform.COVER": '"cover"',
    "Platform.CLIMATE": '"climate"',
    "Platform.BUTTON": '"button"',
}

GATEWAY_TYPE_RE = re.compile(r"GatewayDeviceType\.(\w+)\.value")


def parse_gateway_types(const_py: str) -> dict[str, str]:
    body = re.search(r"class GatewayDeviceType\(.*?\):\n(.*?)\n\s*@classmethod", const_py, re.S)
    if not body:
        raise SystemExit("GatewayDeviceType nicht gefunden")
    out = {}
    for name, value in re.findall(r"^\s{4}(\w+)\s*=\s*'([^']*)'", body.group(1), re.M):
        out[name] = value
    return out


def parse_device_catalog(data_helper_py: str, gw_types: dict[str, str]) -> list[dict]:
    m = re.search(r"^EEP_MAPPING = \[(.*?)^\]", data_helper_py, re.S | re.M)
    if not m:
        raise SystemExit("EEP_MAPPING nicht gefunden")
    src = m.group(1)

    src = GATEWAY_TYPE_RE.sub(lambda mo: json.dumps(gw_types[mo.group(1)]), src)
    for name, repl in CONST_SUBST.items():
        src = re.sub(rf"\b{re.escape(name)}\b", repl, src)

    entries = ast.literal_eval("[" + src + "]")

    catalog = []
    for e in entries:
        item = {"hw": e["hw-type"]}
        for src_key, dst_key in (
            ("brand", "brand"),
            ("eep", "eep"),
            ("platform", "platform"),
            ("sender_eep", "senderEep"),
            ("description", "desc"),
            ("address_count", "channels"),
            ("device_type", "gateway"),
            ("meter_tariffs", "meterTariffs"),
            ("PCT14-function-group", "pct14Fg"),
            ("PCT14-key-function", "pct14Kf"),
        ):
            if src_key in e and e[src_key] not in (None, ""):
                item[dst_key] = e[src_key]
        catalog.append(item)
    return catalog


# -----------------------------------------------------------------------------
# KeyFunction -> KEY_FUNCTIONS
# -----------------------------------------------------------------------------

def parse_key_functions(device_py: str) -> list[list]:
    m = re.search(r"class KeyFunction\(IntEnum\):\n(.*?)\n\n\S", device_py, re.S)
    if not m:
        raise SystemExit("KeyFunction nicht gefunden")
    out = []
    # Trailing-Kommentare zulassen ("... = 32  # for PC/home automation - FUD"):
    # genau die Eintraege 32/51/65 sind die PCT14-Key-Functions aus dem Katalog.
    for name, value in re.findall(r"^\s{4}([A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+|\d+)\s*(?:#.*)?$",
                                  m.group(1), re.M):
        out.append([name, int(value, 0)])
    return out


# -----------------------------------------------------------------------------

TS_HEADER = """\
// AUTO-GENERATED von scripts/gen_eo_man_data.py - NICHT von Hand editieren.
//
// Quellen (Upstream, MIT):
//   grimmpp/enocean-device-manager : eo_man/data/data_helper.py (EEP_MAPPING),
//                                    eo_man/data/const.py (GatewayDeviceType)
//   grimmpp/eltako14bus            : eltakobus/device.py (KeyFunction)
//
// Neu erzeugen: python scripts/gen_eo_man_data.py

/** Ein Eintrag des EO-Man-Geraetekatalogs (dort: EEP_MAPPING). */
export interface CatalogEntry {
    /** Hardware-Typ, z.B. "FSR14_4x". Nicht eindeutig: ein Typ kann mehrere EEPs haben. */
    hw: string;
    brand?: string;
    /** EEP des Geraets (was es sendet bzw. worauf es hoert). */
    eep?: string;
    /** Home-Assistant-Plattform, z.B. "light". */
    platform?: string;
    /** EEP, mit dem HA den Aktor ansteuert (nur bei Aktoren). */
    senderEep?: string;
    desc?: string;
    /** Anzahl Kanaele/Adressen des Geraets. */
    channels?: number;
    /** Gesetzt, wenn der Eintrag ein Gateway ist - Wert = HA device_type. */
    gateway?: string;
    meterTariffs?: string;
    /** PCT14-Funktionsgruppe, in die der HA-Sender eingetragen werden muss. */
    pct14Fg?: number;
    /** PCT14-Tastenfunktion fuer den HA-Sender. */
    pct14Kf?: number;
}

"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=os.path.join(os.path.expanduser("~"), ".cache", "eul-eo-man-src"))
    args = ap.parse_args()

    paths = ensure_sources(args.workdir)

    with open(os.path.join(paths["eo_man"], "eo_man", "data", "const.py"), encoding="utf-8") as f:
        const_py = f.read()
    with open(os.path.join(paths["eo_man"], "eo_man", "data", "data_helper.py"), encoding="utf-8") as f:
        data_helper_py = f.read()
    with open(os.path.join(paths["eltakobus"], "eltakobus", "device.py"), encoding="utf-8") as f:
        device_py = f.read()

    gw_types = parse_gateway_types(const_py)
    catalog = parse_device_catalog(data_helper_py, gw_types)
    key_functions = parse_key_functions(device_py)

    lines = [TS_HEADER]
    lines.append("export const DEVICE_CATALOG: CatalogEntry[] = [")
    for e in catalog:
        lines.append("    " + json.dumps(e, ensure_ascii=False) + ",")
    lines.append("];\n")

    lines.append("/** PCT14-Tastenfunktionen: [Name, Nummer]. */")
    lines.append("export const KEY_FUNCTIONS: ReadonlyArray<readonly [string, number]> = [")
    for name, value in key_functions:
        lines.append(f'    ["{name}", {value}],')
    lines.append("];\n")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"[gen] {os.path.relpath(OUT_PATH, REPO_ROOT)}: "
          f"{len(catalog)} Katalog-Eintraege, {len(key_functions)} Tastenfunktionen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
