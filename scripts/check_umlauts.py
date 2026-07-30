#!/usr/bin/env python3
"""Sucht ASCII-Umschreibungen deutscher Umlaute in SICHTBAREN Texten.

Kommentare und Bezeichner bleiben absichtlich aussen vor: dort ist ASCII die
durchgaengige Konvention des Repos (C-Kommentare, TS-Kommentare). Gesucht wird
nur, was der Nutzer im Portal oder in der Konsole tatsaechlich liest.
"""
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1])

# Woerter, die typischerweise umgeschrieben werden. Bewusst als Wortstaemme,
# damit Beugungen mitkommen.
STEMS = [
    'geraet', 'groess', 'gross', 'muess', 'koenn', 'laeuf', 'faell', 'ueber',
    'fuer', 'zurueck', 'naechst', 'moegl', 'aender', 'loesch', 'schliess',
    'oeffn', 'pruef', 'waehl', 'waehr', 'hoeh', 'stoer', 'erklaer', 'zaehl',
    'staerk', 'verfuegb', 'ausfuehr', 'einfuegen', 'schluessel', 'gueltig',
    'ungueltig', 'zulaess', 'unterstuetz', 'benoetig', 'behoeb', 'erhoeh',
    'loesung', 'schluss', 'draht', 'traeg', 'spaet', 'frueh', 'haeuf',
    'anfaell', 'bestaetig', 'ergaenz', 'uebernehm', 'uebertrag', 'ueblich',
    'grundsaetz', 'saemtl', 'taeglich', 'jaehrl', 'monatl',
]
PATTERN = re.compile('|'.join(STEMS), re.I)

# Zeichenketten in TS/JS/C: einfache, doppelte, Template-Literale.
STRINGS = re.compile(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"|`((?:[^`\\]|\\.)*)`", re.S)


def scan_code(path: Path):
    """Nur Zeichenketten, keine Kommentare."""
    text = path.read_text(encoding='utf-8')
    # Kommentare entfernen, damit sie keine Treffer liefern.
    text = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), text, flags=re.S)
    text = re.sub(r'^\s*//.*$', '', text, flags=re.M)
    text = re.sub(r'([^:\'"`])//.*$', r'\1', text, flags=re.M)

    for m in STRINGS.finditer(text):
        s = m.group(1) or m.group(2) or m.group(3) or ''
        if not PATTERN.search(s):
            continue
        # Bezeichner-artige Treffer (CSS-Selektoren, IDs, URLs) ausblenden.
        if re.fullmatch(r'[\w./#\-\[\]=>: ]*', s) and ' ' not in s.strip():
            continue
        line = text[:m.start()].count('\n') + 1
        yield line, s.strip()[:150]


def scan_html(path: Path):
    """Sichtbare Textknoten und Attribute, ohne <style>/<script>/Kommentare."""
    text = path.read_text(encoding='utf-8')
    text = re.sub(r'<style.*?</style>', lambda m: '\n' * m.group(0).count('\n'), text, flags=re.S)
    text = re.sub(r'<script.*?</script>', lambda m: '\n' * m.group(0).count('\n'), text, flags=re.S)
    text = re.sub(r'<!--.*?-->', lambda m: '\n' * m.group(0).count('\n'), text, flags=re.S)

    for i, line in enumerate(text.split('\n'), 1):
        # sichtbare Attribute
        for m in re.finditer(r'(?:placeholder|title|value|alt|aria-label)="([^"]*)"', line):
            if PATTERN.search(m.group(1)):
                yield i, f'[attr] {m.group(1)[:150]}'
        # Textknoten
        for chunk in re.split(r'<[^>]*>', line):
            chunk = chunk.strip()
            if chunk and PATTERN.search(chunk):
                yield i, chunk[:150]


targets = []
targets += sorted(ROOT.glob('web/src/**/*.ts'))
targets += sorted(ROOT.glob('main/*.c'))

total = 0
for path in targets:
    hits = list(scan_code(path))
    if hits:
        print(f'\n### {path.relative_to(ROOT)}')
        for line, s in hits:
            print(f'  {line:5d}: {s}')
        total += len(hits)

html = ROOT / 'web/index.html'
hits = list(scan_html(html))
if hits:
    print(f'\n### {html.relative_to(ROOT)}')
    for line, s in hits:
        print(f'  {line:5d}: {s}')
    total += len(hits)

print(f'\n=== {total} Fundstellen ===')
