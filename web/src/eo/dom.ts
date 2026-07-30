// Kleine DOM-Helfer fuer die Geraete-Manager-Reiter.

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

/** Wie byId, wirft aber - fuer Elemente, die es laut index.html geben MUSS. */
export function need<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element #${id} fehlt`);
    return el as T;
}

export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default:  return '&#39;';
        }
    });
}

export function optionList(
    values: Array<string | { value: string; label: string }>,
    selected: string,
    emptyLabel?: string,
): string {
    const out: string[] = [];
    if (emptyLabel !== undefined) {
        out.push(`<option value=""${selected ? '' : ' selected'}>${escapeHtml(emptyLabel)}</option>`);
    }
    for (const v of values) {
        const value = typeof v === 'string' ? v : v.value;
        const label = typeof v === 'string' ? v : v.label;
        out.push(
            `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`,
        );
    }
    return out.join('');
}

/** Datei zum Download anbieten, ohne den Server zu belasten. */
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Erst nach dem Klick freigeben - sonst bricht der Download in Safari ab.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Datei per <input type=file> einlesen. Aufloesung mit dem Textinhalt. */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) { resolve(null); return; }
            const reader = new FileReader();
            reader.onload = () => resolve({ name: file.name, text: String(reader.result ?? '') });
            reader.onerror = () => resolve(null);
            reader.readAsText(file);
        });
        // Wird der Dialog abgebrochen, feuert kein Event - der Promise bleibt
        // dann offen. Das ist unkritisch: er haengt an keiner Ressource und
        // der naechste Klick oeffnet einen neuen.
        input.click();
    });
}

/** Zeitpunkt als "HH:MM:SS" bzw. "—" wenn nie. */
export function fmtClock(epochMs: number): string {
    if (!epochMs) return '—';
    const d = new Date(epochMs);
    const p2 = (x: number) => String(x).padStart(2, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
