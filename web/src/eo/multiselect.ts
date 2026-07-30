// Mehrfachauswahl als Klappliste.
//
// Ersetzt das native <select multiple>: das braucht sichtbare Zeilen und wird
// bei 200+ Eintraegen (Geraetetypen, EEPs) unbedienbar. Diese Variante zeigt
// nur einen Knopf und klappt bei Bedarf eine Liste mit Kontrollkaestchen und
// Suchfeld auf - dieselbe Idee wie die ChecklistCombobox von EO-Man
// (eo_man/view/checklistcombobox.py).

import { escapeHtml } from './dom';

/** Alle offenen Listen, damit sich immer nur eine gleichzeitig oeffnet. */
const open = new Set<MultiSelect>();

let globalHandlersInstalled = false;

function installGlobalHandlers(): void {
    if (globalHandlersInstalled) return;
    globalHandlersInstalled = true;
    document.addEventListener('click', (e) => {
        for (const ms of [...open]) {
            if (!ms.root.contains(e.target as Node)) ms.close();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') for (const ms of [...open]) ms.close();
    });
}

export class MultiSelect {
    readonly root: HTMLElement;
    private button: HTMLButtonElement;
    private panel: HTMLElement;
    private search: HTMLInputElement;
    private list: HTMLElement;
    private options: string[] = [];
    private selected = new Set<string>();

    constructor(
        host: HTMLElement,
        private readonly label: string,
        private readonly onChange: () => void,
    ) {
        installGlobalHandlers();

        this.root = host;
        this.root.classList.add('ms');
        this.root.innerHTML =
            `<button type="button" class="ms-btn ghost"></button>` +
            `<div class="ms-panel" hidden>` +
            `<input type="text" class="ms-search" placeholder="Suchen…" autocomplete="off">` +
            `<div class="ms-list"></div>` +
            `<div class="ms-foot"><button type="button" class="ghost ms-clear">Auswahl leeren</button></div>` +
            `</div>`;

        this.button = this.root.querySelector('.ms-btn') as HTMLButtonElement;
        this.panel = this.root.querySelector('.ms-panel') as HTMLElement;
        this.search = this.root.querySelector('.ms-search') as HTMLInputElement;
        this.list = this.root.querySelector('.ms-list') as HTMLElement;

        this.button.addEventListener('click', () => (this.panel.hidden ? this.openPanel() : this.close()));
        this.search.addEventListener('input', () => this.renderList());
        this.root.querySelector('.ms-clear')?.addEventListener('click', () => {
            this.selected.clear();
            this.renderList();
            this.renderButton();
            this.onChange();
        });

        this.list.addEventListener('change', (e) => {
            const cb = e.target;
            if (!(cb instanceof HTMLInputElement)) return;
            if (cb.checked) this.selected.add(cb.value);
            else this.selected.delete(cb.value);
            this.renderButton();
            this.onChange();
        });

        this.renderButton();
    }

    setOptions(values: string[]): void {
        this.options = values;
        this.renderList();
    }

    get value(): string[] {
        return [...this.selected];
    }

    set value(values: string[]) {
        this.selected = new Set(values);
        this.renderList();
        this.renderButton();
    }

    close(): void {
        this.panel.hidden = true;
        open.delete(this);
    }

    private openPanel(): void {
        for (const ms of [...open]) ms.close();
        this.panel.hidden = false;
        open.add(this);
        this.search.value = '';
        this.renderList();
        this.search.focus();
    }

    private renderButton(): void {
        const n = this.selected.size;
        this.button.textContent =
            n === 0 ? `${this.label}: alle` : n === 1 ? `${this.label}: ${[...this.selected][0]}` : `${this.label}: ${n} gewählt`;
        this.button.classList.toggle('ms-active', n > 0);
    }

    private renderList(): void {
        const term = this.search.value.trim().toUpperCase();
        // Ausgewaehltes bleibt immer sichtbar, auch wenn die Suche es
        // ausschliesst - sonst laesst es sich nicht mehr abwaehlen.
        const shown = this.options.filter((o) => !term || o.toUpperCase().includes(term) || this.selected.has(o));

        if (!shown.length) {
            this.list.innerHTML = '<div class="hint" style="padding:6px">kein Treffer</div>';
            return;
        }
        this.list.innerHTML = shown
            .map(
                (o) =>
                    `<label class="ms-item"><input type="checkbox" value="${escapeHtml(o)}"` +
                    `${this.selected.has(o) ? ' checked' : ''}> ${escapeHtml(o)}</label>`,
            )
            .join('');
    }
}
