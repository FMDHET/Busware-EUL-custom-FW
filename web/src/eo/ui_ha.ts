// Reiter "Home Assistant": Gateway-Angaben, Prüfung, YAML-Erzeugung.
//
// Portierung von eo_man/view/menu_presenter.py (export_ha_config) plus der
// Validierung aus ha_config_generator.perform_tests.

import { GATEWAY_TYPES } from './catalog';
import { generateHaConfig, validateSenderIds, type HaGatewayOptions } from './ha_config';
import { byId, downloadText, escapeHtml, optionList } from './dom';
import { eoApp } from './app';

function gatewayOptions(): HaGatewayOptions {
    const deviceType = byId<HTMLSelectElement>('ha_gw_type')?.value || 'eul_lan';
    const isLan = deviceType.includes('lan');
    return {
        deviceType,
        baseId: (byId<HTMLInputElement>('ha_gw_base')?.value || '').trim().toUpperCase(),
        host: isLan ? (byId<HTMLInputElement>('ha_gw_host')?.value || '').trim() : undefined,
        port: isLan ? parseInt(byId<HTMLInputElement>('ha_gw_port')?.value || '0', 10) || undefined : undefined,
        comment: (byId<HTMLInputElement>('ha_gw_comment')?.value || '').trim() || undefined,
    };
}

function exportCandidates() {
    return eoApp.devices().filter((d) => d.useInHa);
}

function renderCheck(): void {
    const box = byId('ha_check');
    if (!box) return;

    const devices = exportCandidates();
    const errors = validateSenderIds(devices);

    if (!devices.length) {
        box.innerHTML =
            '<div class="hint">Kein Gerät ist für den Export markiert. Im Reiter <b>Geräte</b> ' +
            'bei den gewünschten Geräten „In HA verwenden“ setzen.</div>';
        return;
    }
    if (!errors.length) {
        box.innerHTML = `<div class="hint">${devices.length} Gerät(e) markiert · Sender-IDs in Ordnung.</div>`;
        return;
    }
    box.innerHTML =
        `<div style="color:var(--danger)"><b>${errors.length} Problem(e):</b><ul style="margin:6px 0 0 18px">` +
        errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('') +
        '</ul></div>' +
        '<div class="hint">Doppelte Sender-IDs führen dazu, dass mehrere Aktoren auf dasselbe ' +
        'Kommando reagieren. Im Detailformular unter „sender / id“ korrigieren.</div>';
}

let lastYaml = '';

function generate(): void {
    const out = byId('ha_out');
    if (!out) return;

    const gw = gatewayOptions();
    if (!gw.baseId) {
        eoApp.ctx.say('Base-ID fehlt — im Reiter EnOcean auslesen und hier eintragen');
    }

    // Zeitstempel wird in den Kopfkommentar geschrieben; lokale Zeit reicht.
    const now = new Date();
    const stamp = now.toLocaleString('de-DE');

    const res = generateHaConfig(eoApp.doc, gw, stamp);
    lastYaml = res.yaml;
    out.textContent = res.yaml;

    const warn = byId('ha_warn');
    if (warn) {
        warn.innerHTML = res.warnings.length
            ? '<b>Hinweise:</b><ul style="margin:6px 0 0 18px">' +
              res.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('') +
              '</ul>'
            : '';
    }
    eoApp.ctx.say(`${res.exported} Gerät(e) exportiert`);
}

export function initHaTab(): void {
    const typeSel = byId<HTMLSelectElement>('ha_gw_type');
    if (typeSel) typeSel.innerHTML = optionList(GATEWAY_TYPES, 'eul_lan');

    const host = byId<HTMLInputElement>('ha_gw_host');
    if (host && !host.value) host.value = eoApp.ctx.host();
    const port = byId<HTMLInputElement>('ha_gw_port');
    if (port && !port.value) port.value = String(eoApp.ctx.tcpPort());

    const base = byId<HTMLInputElement>('ha_gw_base');
    if (base && !base.value) base.value = eoApp.doc.baseId;
    base?.addEventListener('change', () => {
        eoApp.doc.baseId = base.value.trim().toUpperCase();
        eoApp.touch();
    });

    typeSel?.addEventListener('change', () => {
        const isLan = (typeSel.value || '').includes('lan');
        for (const id of ['ha_gw_host_row', 'ha_gw_port_row']) {
            const el = byId(id);
            if (el) el.style.display = isLan ? '' : 'none';
        }
    });

    byId('ha_generate')?.addEventListener('click', generate);

    byId('ha_copy')?.addEventListener('click', async () => {
        if (!lastYaml) { eoApp.ctx.say('Erst erzeugen'); return; }
        try {
            await navigator.clipboard.writeText(lastYaml);
            eoApp.ctx.say('YAML in die Zwischenablage kopiert');
        } catch {
            eoApp.ctx.say('Kopieren nicht erlaubt — Text bitte manuell markieren');
        }
    });

    byId('ha_download')?.addEventListener('click', () => {
        if (!lastYaml) { eoApp.ctx.say('Erst erzeugen'); return; }
        downloadText('eltako_configuration.yaml', lastYaml, 'application/x-yaml;charset=utf-8');
    });

    eoApp.onDevicesChanged(renderCheck);
    renderCheck();
}
