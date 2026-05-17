/**
 * Settings page wiring — profile editor + global toggles.
 */

import { characters, saveSettingsDebounced } from '/script.js';
import { extension_settings, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { Popup, POPUP_TYPE } from '/scripts/popup.js';

import {
    settings,
    listProfiles,
    getProfile,
    saveProfile,
    deleteProfile,
    cloneProfile,
    resetDefaultProfiles,
    setSelectedProfile,
    CARD_FIELDS,
} from './src/profiles.js';
import { listAiConnectionProfiles, convertOneCard, SECTION_DEFAULTS, sectionDefaultsFor } from './src/conversionEngine.js';
import { log, EXT_KEY } from './src/core.js';

// All known section names — built-ins plus any custom ones the user defined
// via the section-overrides UI. Resolved at render time per-profile.
function knownSections(profile) {
    const builtins = Object.keys(SECTION_DEFAULTS);
    const custom = Object.keys(profile?.sectionOverrides || {});
    return [...new Set([...builtins, ...custom])];
}

let editingProfileId = null;

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ============================================================
 * UI rendering
 * ============================================================ */

function renderProfileList() {
    const container = $('c2l-profile-list');
    if (!container) return;
    const profiles = listProfiles();
    const selectedId = editingProfileId || profiles[0]?.id;

    container.innerHTML = profiles.map(p => `
        <div class="c2l-profile-row ${p.id === selectedId ? 'active' : ''} ${p.builtin ? 'builtin' : ''}" data-id="${escapeHtml(p.id)}">
            <span class="c2l-profile-name">${escapeHtml(p.name)}</span>
        </div>
    `).join('');

    container.querySelectorAll('.c2l-profile-row').forEach(row => {
        row.addEventListener('click', () => {
            editingProfileId = row.dataset.id;
            renderProfileList();
            renderEditor();
        });
    });
}

function renderEditor() {
    const profile = getProfile(editingProfileId) || listProfiles()[0];
    if (!profile) return;
    editingProfileId = profile.id;

    $('c2l-prof-name-label').textContent = profile.name;
    $('c2l-prof-name').value = profile.name;
    $('c2l-prof-base').value = profile.baseInstruction || '';
    $('c2l-prof-split').value = profile.entrySplitMode || 'flat';
    $('c2l-prof-wordcap').value = profile.wordCap || 600;
    $('c2l-prof-response').value = profile.responseLength || 1500;
    $('c2l-prof-output').value = profile.outputFormat || 'json';
    $('c2l-prof-conflict').value = profile.conflictPolicy || 'ask';
    $('c2l-prof-card-summary').checked = profile.alsoExtractCardSummary !== false;
    if ($('c2l-prof-roster')) $('c2l-prof-roster').checked = profile.generateRoster !== false;

    // AI connection profile dropdown.
    const aiProfiles = listAiConnectionProfiles();
    const aiSelect = $('c2l-prof-ai');
    aiSelect.innerHTML = ['<option value="">&lt;Use current connection&gt;</option>']
        .concat(aiProfiles.map(p => {
            const id = p?.id || p?.name || '';
            const name = p?.name || id;
            return `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`;
        }))
        .join('');
    aiSelect.value = profile.aiConnectionProfile || '';

    // Field toggles.
    const fieldsContainer = $('c2l-prof-fields');
    fieldsContainer.innerHTML = CARD_FIELDS.map(f => {
        const on = profile.includeFields?.[f.key] !== false;
        return `
            <label class="checkbox_label">
                <input type="checkbox" data-field="${escapeHtml(f.key)}" ${on ? 'checked' : ''}>
                <span>${escapeHtml(f.label)}</span>
            </label>
        `;
    }).join('');

    // Test-on-character dropdown — list all loaded characters.
    const testSel = $('c2l-prof-test-char');
    if (testSel) {
        testSel.innerHTML = characters
            .map((c, i) => `<option value="${i}">${escapeHtml(c.name || `Char ${i}`)}</option>`)
            .join('') || '<option value="">(no characters loaded)</option>';
    }

    // P2.16 cost ceiling
    $('c2l-prof-max-tokens').value = Number(profile.maxEstimatedTokens) || 0;

    // P3.19/20 section overrides editor.
    renderSectionOverrides(profile);
}

function renderSectionOverrides(profile) {
    const container = $('c2l-prof-sections');
    if (!container) return;
    const sections = knownSections(profile);
    container.innerHTML = sections.map(s => {
        const builtin = SECTION_DEFAULTS[s];
        const ov = profile.sectionOverrides?.[s] || {};
        const isCustom = !builtin;
        return `
            <div class="c2l-section-row" data-section="${escapeHtml(s)}">
                <span class="c2l-section-name">${escapeHtml(s)}${isCustom ? ' (custom)' : ''}</span>
                <label>order <input type="number" class="text_pole c2l-sec-order" value="${ov.order ?? ''}" placeholder="${builtin?.order ?? 100}" style="width:70px"></label>
                <label>prob <input type="number" class="text_pole c2l-sec-prob" min="0" max="100" value="${ov.probability ?? ''}" placeholder="${builtin?.probability ?? 100}" style="width:60px"></label>
                <label>word cap <input type="number" class="text_pole c2l-sec-wcap" value="${ov.wordCap ?? ''}" placeholder="${builtin?.wordCap ?? 250}" style="width:70px"></label>
                <label>constant <select class="text_pole c2l-sec-const" style="width:90px">
                    <option value="">(default)</option>
                    <option value="true" ${ov.constant === true ? 'selected' : ''}>true</option>
                    <option value="false" ${ov.constant === false ? 'selected' : ''}>false</option>
                </select></label>
                ${isCustom ? `<button type="button" class="menu_button c2l-sec-remove" data-section="${escapeHtml(s)}">×</button>` : ''}
            </div>
        `;
    }).join('');

    // Wire row inputs — write back into profile.sectionOverrides on change.
    container.querySelectorAll('.c2l-section-row').forEach(rowEl => {
        const s = rowEl.dataset.section;
        const apply = () => {
            const ov = profile.sectionOverrides[s] = profile.sectionOverrides[s] || {};
            const order = Number(rowEl.querySelector('.c2l-sec-order').value);
            const prob = Number(rowEl.querySelector('.c2l-sec-prob').value);
            const wcap = Number(rowEl.querySelector('.c2l-sec-wcap').value);
            const constVal = rowEl.querySelector('.c2l-sec-const').value;
            if (Number.isFinite(order) && order !== 0) ov.order = order; else delete ov.order;
            if (Number.isFinite(prob) && prob !== 0)  ov.probability = prob; else delete ov.probability;
            if (Number.isFinite(wcap) && wcap !== 0)  ov.wordCap = wcap; else delete ov.wordCap;
            if (constVal === 'true')  ov.constant = true;
            else if (constVal === 'false') ov.constant = false;
            else delete ov.constant;
            if (Object.keys(ov).length === 0) delete profile.sectionOverrides[s];
        };
        rowEl.querySelectorAll('input, select').forEach(el => el.addEventListener('change', apply));
        rowEl.querySelector('.c2l-sec-remove')?.addEventListener('click', () => {
            delete profile.sectionOverrides[s];
            renderSectionOverrides(profile);
        });
    });
}

function readEditorIntoProfile() {
    const profile = getProfile(editingProfileId);
    if (!profile) return null;
    profile.name = $('c2l-prof-name').value.trim() || profile.name;
    profile.baseInstruction = $('c2l-prof-base').value;
    profile.entrySplitMode = $('c2l-prof-split').value === 'modular' ? 'modular' : 'flat';
    profile.wordCap = Number($('c2l-prof-wordcap').value) || 600;
    profile.responseLength = Number($('c2l-prof-response').value) || 1500;
    profile.outputFormat = $('c2l-prof-output').value;
    profile.conflictPolicy = $('c2l-prof-conflict').value;
    profile.aiConnectionProfile = $('c2l-prof-ai').value || '';
    profile.alsoExtractCardSummary = $('c2l-prof-card-summary').checked;
    if ($('c2l-prof-roster')) profile.generateRoster = $('c2l-prof-roster').checked;
    profile.maxEstimatedTokens = Math.max(0, Number($('c2l-prof-max-tokens').value) || 0);

    profile.includeFields = profile.includeFields || {};
    $('c2l-prof-fields').querySelectorAll('input[data-field]').forEach(cb => {
        profile.includeFields[cb.dataset.field] = cb.checked;
    });
    // Section overrides are already mutated in-place by renderSectionOverrides handlers.
    profile.sectionOverrides = profile.sectionOverrides || {};
    return profile;
}

/* ============================================================
 * Event wiring
 * ============================================================ */

function wireEvents() {
    $('c2l-enabled').addEventListener('change', e => {
        settings().enabled = e.target.checked;
        saveSettingsDebounced();
    });
    $('c2l-debug').addEventListener('change', e => {
        settings().debug = e.target.checked;
        saveSettingsDebounced();
    });
    $('c2l-queue-delay').addEventListener('input', e => {
        settings().queueDelayMs = Math.max(0, Number(e.target.value) || 0);
        saveSettingsDebounced();
    });
    $('c2l-queue-parallel').addEventListener('input', e => {
        settings().queueParallelism = Math.max(1, Math.min(8, Number(e.target.value) || 1));
        saveSettingsDebounced();
    });

    $('c2l-profile-clone').addEventListener('click', () => {
        if (!editingProfileId) return;
        const copy = cloneProfile(editingProfileId);
        if (copy) {
            editingProfileId = copy.id;
            renderProfileList();
            renderEditor();
            toastr.success(`Cloned to "${copy.name}".`, 'Card to Lorebook');
        }
    });

    $('c2l-profile-delete').addEventListener('click', () => {
        const profile = getProfile(editingProfileId);
        if (!profile) return;
        if (profile.builtin) {
            const ok = confirm(`"${profile.name}" is a built-in profile. Deleting will remove it from the list (you can restore via "Reset built-ins"). Continue?`);
            if (!ok) return;
        } else {
            const ok = confirm(`Delete profile "${profile.name}"?`);
            if (!ok) return;
        }
        deleteProfile(editingProfileId);
        editingProfileId = listProfiles()[0]?.id;
        renderProfileList();
        renderEditor();
    });

    $('c2l-profile-reset-builtins').addEventListener('click', () => {
        const ok = confirm('Restore the three built-in profiles to their original state? User-created profiles are preserved.');
        if (!ok) return;
        resetDefaultProfiles();
        renderProfileList();
        renderEditor();
        toastr.success('Built-in profiles reset.', 'Card to Lorebook');
    });

    $('c2l-prof-save').addEventListener('click', () => {
        const p = readEditorIntoProfile();
        if (!p) return;
        saveProfile(p);
        toastr.success(`Saved "${p.name}".`, 'Card to Lorebook');
        renderProfileList();
        renderEditor();
    });

    /* --- Test on one card (P1.8) --- */
    $('c2l-prof-test-run').addEventListener('click', async () => {
        const profile = readEditorIntoProfile();
        if (!profile) return;
        saveProfile(profile);
        const idx = Number($('c2l-prof-test-char').value);
        const card = characters[idx];
        if (!card) {
            toastr.warning('Pick a character first.', 'Card to Lorebook');
            return;
        }
        const btn = $('c2l-prof-test-run');
        btn.disabled = true;
        btn.textContent = 'Testing…';
        try {
            const entries = await convertOneCard(card, profile);
            await showTestResultPopup(card, profile, entries);
        } catch (e) {
            toastr.error(String(e?.message || e), 'Test failed');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Run test';
        }
    });

    /* --- Profile export (P1.11) --- */
    $('c2l-prof-export').addEventListener('click', () => {
        const p = getProfile(editingProfileId);
        if (!p) return;
        const json = JSON.stringify({ ...p, _exportedAt: new Date().toISOString() }, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `c2l-profile-${p.id}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    /* --- Profile import (P1.11) --- */
    $('c2l-prof-import-file').addEventListener('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            const incoming = JSON.parse(text);
            if (!incoming || typeof incoming !== 'object' || !incoming.baseInstruction) {
                throw new Error('Not a valid Card-to-Lorebook profile JSON.');
            }
            // Generate a fresh id, mark as user-owned (never overwrite builtin slots)
            incoming.id = `custom_${Date.now().toString(36)}`;
            incoming.builtin = false;
            delete incoming._exportedAt;
            if (!incoming.name) incoming.name = 'Imported profile';
            saveProfile(incoming);
            editingProfileId = incoming.id;
            renderProfileList();
            renderEditor();
            toastr.success(`Imported "${incoming.name}".`, 'Card to Lorebook');
        } catch (e) {
            toastr.error(String(e?.message || e), 'Import failed');
        }
    });

    // P3.19 add custom section button
    $('c2l-prof-section-add').addEventListener('click', () => {
        const input = $('c2l-prof-section-add-name');
        const name = String(input.value || '').trim().toLowerCase().replace(/\W+/g, '_');
        if (!name) {
            toastr.warning('Enter a section name first.', 'Card to Lorebook');
            return;
        }
        const profile = getProfile(editingProfileId);
        if (!profile) return;
        profile.sectionOverrides = profile.sectionOverrides || {};
        if (!profile.sectionOverrides[name]) {
            profile.sectionOverrides[name] = { order: 250, probability: 100, wordCap: 250 };
        }
        input.value = '';
        renderSectionOverrides(profile);
    });

    // Initial values
    $('c2l-enabled').checked = settings().enabled !== false;
    $('c2l-debug').checked = !!settings().debug;
    $('c2l-queue-delay').value = settings().queueDelayMs || 0;
    $('c2l-queue-parallel').value = settings().queueParallelism || 1;
}

/**
 * Show a popup with the test-conversion result — raw JSON of generated
 * entries so the user can iterate on the profile prompt.
 */
async function showTestResultPopup(card, profile, entries) {
    const body = document.createElement('div');
    body.style.minWidth = '640px';
    body.style.maxWidth = '900px';
    body.innerHTML = `
        <h3 style="margin:0">Test result — ${escapeHtml(card.name)} · profile "${escapeHtml(profile.name)}"</h3>
        <p style="margin:4px 0; opacity:0.7; font-size:0.85em;">
            ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} generated.
            Iterate on the base instruction above and rerun until the keys/structure look right.
        </p>
        <div style="max-height:540px; overflow-y:auto; border:1px solid var(--SmartThemeBorderColor); border-radius:6px; padding:6px; background:var(--SmartThemeBlurTintColor);">
            ${entries.map((e, i) => `
                <div style="margin-bottom:10px; padding-bottom:8px; border-bottom:1px dashed var(--black20a);">
                    <div style="display:flex; gap:8px; align-items:center; margin-bottom:4px;">
                        <b>${i + 1}. ${escapeHtml(e.comment || '(no stamp)')}</b>
                        <span style="opacity:0.65; font-size:0.8em;">order ${e.order} · prob ${e.probability ?? 100} · ${e.constant ? 'constant' : 'selective'} · selLogic ${e.selectiveLogic ?? 0}</span>
                    </div>
                    <div style="font-size:0.85em; opacity:0.85;"><b>keys:</b> ${escapeHtml((e.keys || []).join(', '))}</div>
                    ${e.secondaryKeys?.length ? `<div style="font-size:0.85em; opacity:0.85;"><b>secondary:</b> ${escapeHtml(e.secondaryKeys.join(', '))}</div>` : ''}
                    <pre style="font-size:0.82em; white-space:pre-wrap; margin:4px 0 0; max-height:200px; overflow-y:auto;">${escapeHtml(e.content || '')}</pre>
                </div>
            `).join('')}
        </div>
    `;
    await new Popup(body, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', cancelButton: false }).show();
}

/* ============================================================
 * Mount
 * ============================================================ */

export async function mountSettingsPanel() {
    if (document.getElementById('card_to_lore_settings')) {
        return; // already mounted
    }
    try {
        const html = await renderExtensionTemplateAsync(`third-party/${EXT_KEY}`, 'settings', {});
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host) {
            log('extensions_settings container not found yet; will retry');
            return;
        }
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        host.appendChild(wrap.firstElementChild);
        editingProfileId = settings().selectedProfileId || listProfiles()[0]?.id;
        renderProfileList();
        renderEditor();
        wireEvents();
        log('settings panel mounted');
    } catch (e) {
        // If the template path isn't found (the EXT_KEY-based path), fall back
        // to fetching settings.html directly relative to the extension folder.
        log('renderExtensionTemplateAsync failed, falling back to fetch', e);
        await mountSettingsPanelFallback();
    }
}

async function mountSettingsPanelFallback() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const res = await fetch(`/scripts/extensions/third-party/${EXT_KEY}/settings.html`);
    if (!res.ok) {
        // The extension lives under data/default-user/extensions — that ST also
        // serves via the same /scripts/extensions/third-party path at runtime.
        // If even that 404s we give up.
        console.warn('[Card2Lore] failed to load settings.html');
        return;
    }
    const html = await res.text();
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    host.appendChild(wrap.firstElementChild);
    editingProfileId = settings().selectedProfileId || listProfiles()[0]?.id;
    renderProfileList();
    renderEditor();
    wireEvents();
    log('settings panel mounted (fallback)');
}
