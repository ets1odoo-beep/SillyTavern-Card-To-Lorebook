/**
 * Settings page wiring — profile editor + global toggles.
 */

import { saveSettingsDebounced } from '/script.js';
import { extension_settings, renderExtensionTemplateAsync } from '/scripts/extensions.js';

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
import { listAiConnectionProfiles } from './src/conversionEngine.js';
import { log, EXT_KEY } from './src/core.js';

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

    profile.includeFields = profile.includeFields || {};
    $('c2l-prof-fields').querySelectorAll('input[data-field]').forEach(cb => {
        profile.includeFields[cb.dataset.field] = cb.checked;
    });
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

    // Initial values
    $('c2l-enabled').checked = settings().enabled !== false;
    $('c2l-debug').checked = !!settings().debug;
    $('c2l-queue-delay').value = settings().queueDelayMs || 0;
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
