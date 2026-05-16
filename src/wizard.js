/**
 * Multi-step wizard popup. State machine in JS, single Popup container with
 * step content swapped via innerHTML. Steps:
 *
 *   1. source   — list of selected cards, show embedded-book counts
 *   2. profile  — choose conversion profile + AI connection
 *   3. dest     — destination + conflict policy
 *   4. preflight — cost preview, confirm
 *   5. progress — sequential queue with cancel + per-card status
 *   6. preview  — editable entry table, commit / discard
 *   7. done     — success toast + open lorebook
 */

import { Popup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';
import { characters } from '/script.js';

import { getCardByIndex, getEmbeddedBookEntries, hasExtractableContent, buildCardPromptText, preflightStats } from './cardExtractor.js';
import { listProfiles, getProfile, getSelectedProfile, setSelectedProfile, settings } from './profiles.js';
import { listAiConnectionProfiles } from './conversionEngine.js';
import { convertOneCard } from './conversionEngine.js';
import { listAllWorlds, commitEntries, makeCardStamp, makeEmbeddedStamp, openWorldInfoEditor, removeStampedEntries } from './lorebookIO.js';
import { defaultLorebookName, estimateTokens, log, warn, err } from './core.js';

const STEPS = ['source', 'profile', 'dest', 'preflight', 'progress', 'preview', 'done'];

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function avatarUrl(card) {
    if (!card?.avatar) return '/img/ai4.png';
    return `/characters/${encodeURIComponent(card.avatar)}`;
}

/* ============================================================
 * Wizard state
 * ============================================================ */

function newWizardState(selectedIds) {
    const cards = (selectedIds || [])
        .map(id => ({ id, card: getCardByIndex(id) }))
        .filter(x => x.card);

    return {
        currentStep: 'source',
        cards,                       // [{ id, card }]
        profileId: settings().selectedProfileId,
        destination: {
            mode: 'new',                                  // new | existing | chat | character
            name: defaultLorebookName(),
            characterAvatar: '',
        },
        conflictPolicy: 'ask',
        wipeBeforeCommit: false,     // P1.12 redo-from-scratch toggle
        queue: [],                   // [{ cardIdx, status, error, entries, t0, t1 }]
        embedded: [],                // [{ cardName, entries: [internalEntry, ...] }]
        previewRows: [],             // editable entries for step 6
        abortController: null,
    };
}

/* ============================================================
 * Stepbar
 * ============================================================ */

function renderStepbar(state) {
    const labels = {
        source: 'Source',
        profile: 'Profile',
        dest: 'Destination',
        preflight: 'Confirm',
        progress: 'Running',
        preview: 'Preview',
        done: 'Done',
    };
    const idx = STEPS.indexOf(state.currentStep);
    return STEPS.map((s, i) => {
        let cls = 'c2l-step-pill';
        if (s === state.currentStep) cls += ' active';
        else if (i < idx) cls += ' done';
        return `<span class="${cls}">${labels[s]}</span>`;
    }).join('');
}

/* ============================================================
 * Step renderers
 * ============================================================ */

function renderStepSource(state) {
    if (state.cards.length === 0) {
        return `
            <h3>Source review</h3>
            <p class="c2l-hint">No usable characters were selected. Cancel and pick at least one card.</p>
        `;
    }

    const rows = state.cards.map(({ card }) => {
        const hasBook = (card.data?.character_book?.entries?.length ?? 0) > 0;
        const bookCount = card.data?.character_book?.entries?.length ?? 0;
        const empty = !hasExtractableContent(card, getProfile(state.profileId));
        return `
            <div class="c2l-source-row" data-name="${escapeHtml(card.name)}">
                <img src="${avatarUrl(card)}" alt="">
                <span class="c2l-source-name">${escapeHtml(card.name)}</span>
                ${hasBook ? `<span class="c2l-source-tag book" title="Embedded character_book">📚 ${bookCount} embedded</span>` : ''}
                ${empty ? `<span class="c2l-source-tag empty" title="No content matches the profile's field filters">⚠ empty</span>` : ''}
            </div>
        `;
    }).join('');

    const totalEmbedded = state.cards.reduce(
        (n, { card }) => n + (card.data?.character_book?.entries?.length || 0), 0,
    );

    return `
        <h3>Source review</h3>
        <p class="c2l-hint">${state.cards.length} card${state.cards.length === 1 ? '' : 's'} selected${totalEmbedded ? `. <b>${totalEmbedded}</b> embedded character_book entries will import verbatim alongside AI-generated summaries.` : '.'}</p>
        <div class="c2l-source-list">${rows}</div>
    `;
}

function renderStepProfile(state) {
    const profiles = listProfiles();
    const profile = getProfile(state.profileId);
    const aiProfiles = listAiConnectionProfiles();

    const profileOpts = profiles
        .map(p => `<option value="${escapeHtml(p.id)}" ${p.id === state.profileId ? 'selected' : ''}>${escapeHtml(p.name)}${p.builtin ? ' (built-in)' : ''}</option>`)
        .join('');

    const aiOpts = ['<option value="">&lt;Use current AI connection&gt;</option>']
        .concat(aiProfiles.map(p => {
            const id = p?.id || p?.name || '';
            const name = p?.name || id;
            return `<option value="${escapeHtml(id)}" ${id === (profile?.aiConnectionProfile || '') ? 'selected' : ''}>${escapeHtml(name)}</option>`;
        }))
        .join('');

    return `
        <h3>Profile + AI</h3>
        <div class="c2l-row">
            <label><span>Conversion profile</span>
                <select id="c2l-prof-select" class="text_pole">${profileOpts}</select>
            </label>
            <label><span>AI connection profile (overrides profile setting)</span>
                <select id="c2l-ai-select" class="text_pole">${aiOpts}</select>
            </label>
        </div>
        <p class="c2l-hint">Profile prompt preview (edit in extension settings if you want to change it permanently):</p>
        <textarea id="c2l-prof-preview" readonly rows="6" class="text_pole textarea_compact" style="font-size:0.85em">${escapeHtml(profile?.baseInstruction || '')}</textarea>
        <p class="c2l-hint">Word cap: <b>${profile?.wordCap || '—'}</b> · Output format: <b>${profile?.outputFormat || '—'}</b> · Conflict policy default: <b>${profile?.conflictPolicy || '—'}</b></p>
    `;
}

function renderStepDest(state) {
    const worlds = listAllWorlds();
    const charOpts = characters
        .map((c, i) => `<option value="${escapeHtml(c.avatar)}">${escapeHtml(c.name)}</option>`)
        .join('');
    const worldOpts = worlds.length
        ? worlds.map(w => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`).join('')
        : '<option value="">(no existing lorebooks)</option>';

    const mode = state.destination.mode;
    return `
        <h3>Destination</h3>
        <div style="display:flex; flex-direction:column; gap:6px;">
            <label class="c2l-toggle"><input type="radio" name="c2l-mode" value="new" ${mode === 'new' ? 'checked' : ''}> <span>Create a new lorebook</span></label>
            <div class="c2l-row" style="margin-left:24px;${mode !== 'new' ? 'display:none' : ''}" id="c2l-mode-new-detail">
                <label><span>Name</span><input id="c2l-dest-newname" type="text" class="text_pole" value="${escapeHtml(state.destination.name)}"></label>
            </div>

            <label class="c2l-toggle"><input type="radio" name="c2l-mode" value="existing" ${mode === 'existing' ? 'checked' : ''}> <span>Append to existing lorebook</span></label>
            <div class="c2l-row" style="margin-left:24px;${mode !== 'existing' ? 'display:none' : ''}" id="c2l-mode-existing-detail">
                <label><span>Lorebook</span><select id="c2l-dest-existing" class="text_pole">${worldOpts}</select></label>
            </div>

            <label class="c2l-toggle"><input type="radio" name="c2l-mode" value="chat" ${mode === 'chat' ? 'checked' : ''}> <span>Bind a new lorebook to the current chat</span></label>
            <div class="c2l-row" style="margin-left:24px;${mode !== 'chat' ? 'display:none' : ''}" id="c2l-mode-chat-detail">
                <label><span>Name</span><input id="c2l-dest-chatname" type="text" class="text_pole" value="${escapeHtml(state.destination.name)}"></label>
            </div>

            <label class="c2l-toggle"><input type="radio" name="c2l-mode" value="character" ${mode === 'character' ? 'checked' : ''}> <span>Write into a character's embedded book</span></label>
            <div class="c2l-row" style="margin-left:24px;${mode !== 'character' ? 'display:none' : ''}" id="c2l-mode-character-detail">
                <label><span>Target character</span><select id="c2l-dest-character" class="text_pole">${charOpts}</select></label>
                <p class="c2l-hint" style="flex-basis:100%">Note: character_book writes are in-memory until you save the character.</p>
            </div>
        </div>
        <hr style="opacity:0.2">
        <div class="c2l-row">
            <label><span>Conflict policy (existing destinations only)</span>
                <select id="c2l-conflict" class="text_pole">
                    <option value="ask" ${state.conflictPolicy === 'ask' ? 'selected' : ''}>Ask per entry</option>
                    <option value="skip" ${state.conflictPolicy === 'skip' ? 'selected' : ''}>Skip (keep existing)</option>
                    <option value="overwrite" ${state.conflictPolicy === 'overwrite' ? 'selected' : ''}>Overwrite</option>
                    <option value="append" ${state.conflictPolicy === 'append' ? 'selected' : ''}>Append as new</option>
                </select>
            </label>
        </div>
        <label class="c2l-toggle" style="margin-top:6px;">
            <input id="c2l-wipe-before" type="checkbox" ${state.wipeBeforeCommit ? 'checked' : ''}>
            <span><b>Redo from scratch</b> — remove existing <code>[card2lore:*]</code> stamped entries from the target lorebook before committing. Hand-written entries are preserved.</span>
        </label>
    `;
}

function renderStepPreflight(state) {
    const profile = getProfile(state.profileId);
    const cards = state.cards.map(x => x.card);
    const stats = preflightStats(cards, profile);
    const queueDelay = settings().queueDelayMs || 0;
    const seconds = Math.ceil((stats.nonEmptyCards * 5) + (stats.nonEmptyCards * queueDelay / 1000));
    const minutes = (seconds / 60).toFixed(1);

    let destLabel = '';
    switch (state.destination.mode) {
        case 'new': destLabel = `new lorebook <b>${escapeHtml(state.destination.name)}</b>`; break;
        case 'existing': destLabel = `existing lorebook <b>${escapeHtml(state.destination.name)}</b>`; break;
        case 'chat': destLabel = `chat-bound lorebook <b>${escapeHtml(state.destination.name)}</b>`; break;
        case 'character':
            const c = characters.find(x => x.avatar === state.destination.characterAvatar);
            destLabel = `<b>${escapeHtml(c?.name || 'Unknown')}</b>'s embedded book`;
            break;
    }

    // P2.16 cost ceiling — warn if estimated cost > profile.maxEstimatedTokens
    const ceiling = Number(profile?.maxEstimatedTokens) || 0;
    const ceilingExceeded = ceiling > 0 && stats.estimatedTokensTotal > ceiling;
    const ceilingNote = ceiling
        ? (ceilingExceeded
            ? `<p class="c2l-hint" style="color:var(--warning, #d7a900);"><b>⚠ Cost ceiling exceeded</b> — profile cap is ${ceiling.toLocaleString()} tokens, estimated ${stats.estimatedTokensTotal.toLocaleString()}. Click Start to override.</p>`
            : `<p class="c2l-hint">Within profile cost ceiling (${ceiling.toLocaleString()} tokens).</p>`)
        : '';

    return `
        <h3>Confirm</h3>
        <div class="c2l-progress-summary">
            <span><b>${stats.cards}</b> cards selected</span>
            <span><b>${stats.nonEmptyCards}</b> will run through AI</span>
            <span><b>${stats.embeddedEntries}</b> embedded entries import verbatim</span>
            <span>Estimated <b>~${stats.estimatedTokensTotal.toLocaleString()}</b> tokens total</span>
            <span>~${minutes} min sequential (delay ${queueDelay}ms)</span>
        </div>
        <p class="c2l-hint">Profile: <b>${escapeHtml(getProfile(state.profileId)?.name || '')}</b> · Destination: ${destLabel} · Conflicts: <b>${state.conflictPolicy}</b>${state.wipeBeforeCommit ? ' · <b>wiping existing card2lore stamps</b>' : ''}</p>
        ${ceilingNote}
        <p class="c2l-hint">Click Start to run the queue. You can cancel mid-batch — completed entries still appear in preview.</p>
    `;
}

function renderStepProgress(state) {
    const now = Date.now();
    const rows = state.queue.map((q, i) => {
        const card = state.cards[i]?.card;
        const icons = { queued: '⏸', running: '⟳', done: '✓', failed: '⚠', skipped: '↷', cancelled: '×' };
        let elapsedStr = '';
        if (q.status === 'running' && q.t0) {
            elapsedStr = `${Math.floor((now - q.t0) / 1000)}s…`;
        } else if (q.status === 'done' && q.t0 && q.t1) {
            elapsedStr = `${Math.floor((q.t1 - q.t0) / 1000)}s · ${q.entries?.length || 0} entries`;
        } else if (q.status === 'failed' && q.error) {
            elapsedStr = q.error;
        } else if (q.status === 'skipped') {
            elapsedStr = 'skipped';
        }
        return `
            <div class="c2l-progress-row">
                <span class="c2l-status-icon ${q.status}">${icons[q.status] || '?'}</span>
                <span class="c2l-progress-name">${escapeHtml(card?.name || '(unknown)')}</span>
                <span class="c2l-progress-detail">${escapeHtml(elapsedStr)}</span>
            </div>
        `;
    }).join('');
    const done = state.queue.filter(q => q.status === 'done').length;
    const failed = state.queue.filter(q => q.status === 'failed').length;
    const skipped = state.queue.filter(q => q.status === 'skipped').length;
    const total = state.queue.length;
    const totalElapsed = state.queue
        .filter(q => q.t0)
        .reduce((sum, q) => sum + ((q.t1 || now) - q.t0), 0);
    return `
        <h3>Running conversion</h3>
        <div class="c2l-progress-summary">
            <span>Progress: <b>${done + failed + skipped}</b> / <b>${total}</b></span>
            <span>Done: <b>${done}</b></span>
            <span>Failed: <b>${failed}</b></span>
            <span>Skipped: <b>${skipped}</b></span>
            <span>Elapsed: <b>${Math.floor(totalElapsed / 1000)}s</b></span>
        </div>
        <div class="c2l-progress-list">${rows}</div>
        <p class="c2l-hint">When the queue finishes, you'll see all entries (including embedded character_book imports) in the preview step where you can edit before committing.</p>
    `;
}

function renderStepPreview(state) {
    // Group rows by parent card so a 7-section character is one collapsible block.
    const groups = new Map(); // cardName -> [row indexes]
    state.previewRows.forEach((r, idx) => {
        const k = r.cardName || '(unknown)';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(idx);
    });

    const groupsHtml = [...groups.entries()].map(([cardName, indexes], gi) => {
        const kept = indexes.filter(i => !state.previewRows[i].dropped).length;
        const total = indexes.length;
        const rowsHtml = indexes.map(i => renderPreviewRow(state.previewRows[i], i)).join('');
        return `
            <details class="c2l-preview-group" open data-card="${escapeHtml(cardName)}">
                <summary class="c2l-preview-group-head">
                    <span class="c2l-preview-group-name">${escapeHtml(cardName)}</span>
                    <span class="c2l-preview-group-count">${kept}/${total} entries kept</span>
                    <span style="flex:1"></span>
                    <button type="button" class="menu_button c2l-group-drop" data-card="${escapeHtml(cardName)}">Drop all</button>
                    <button type="button" class="menu_button c2l-group-restore" data-card="${escapeHtml(cardName)}">Restore all</button>
                </summary>
                <div class="c2l-preview-group-body">${rowsHtml}</div>
            </details>
        `;
    }).join('');

    const total = state.previewRows.length;
    const kept = state.previewRows.filter(r => !r.dropped).length;
    const profile = getProfile(state.profileId);
    const modeNote = profile?.entrySplitMode === 'modular'
        ? `Modular mode — each card produces up to 7 sub-entries with section-specific keys.`
        : `Flat mode — one entry per card.`;
    return `
        <h3>Preview &amp; edit</h3>
        <p class="c2l-hint"><b>${kept}</b> of <b>${total}</b> entries will be committed. ${modeNote}</p>
        <div class="c2l-bulk-bar">
            <label>Bulk actions:</label>
            <button type="button" class="menu_button" data-bulk="drop-section" data-section="background">Drop all background</button>
            <button type="button" class="menu_button" data-bulk="drop-section" data-section="quirks">Drop all quirks</button>
            <button type="button" class="menu_button" data-bulk="set-prob">Set all probability to…</button>
            <button type="button" class="menu_button" data-bulk="set-constant">All constant on</button>
            <button type="button" class="menu_button" data-bulk="set-selective">All selective on</button>
        </div>
        <div class="c2l-preview-table">${groupsHtml || '<p style="padding:8px; opacity:0.7;">No entries to preview.</p>'}</div>
    `;
}

function renderPreviewRow(r, i) {
    const tagClass = r.kind === 'embedded' ? 'book' : '';
    return `
        <div class="c2l-preview-row ${r.dropped ? 'dropped' : ''}" data-i="${i}">
            <div class="c2l-preview-head">
                <span class="c2l-preview-tag ${tagClass}">${escapeHtml(r.kind)}</span>
                <input type="text" class="text_pole c2l-prev-name" value="${escapeHtml(r.comment || '')}" placeholder="Entry name/comment">
                <button type="button" class="menu_button danger c2l-prev-drop">${r.dropped ? 'Restore' : 'Drop'}</button>
            </div>
            <input type="text" class="text_pole c2l-prev-keys" value="${escapeHtml((r.keys || []).join(', '))}" placeholder="Primary keys (comma-separated)">
            <input type="text" class="text_pole c2l-prev-skeys" value="${escapeHtml((r.secondaryKeys || []).join(', '))}" placeholder="Secondary keys (optional)" style="margin-top:3px;">
            <textarea class="text_pole textarea_compact c2l-prev-content" rows="6">${escapeHtml(r.content || '')}</textarea>
            <div class="c2l-preview-meta">
                <label><input type="checkbox" class="c2l-prev-constant" ${r.constant ? 'checked' : ''}> constant</label>
                <label><input type="checkbox" class="c2l-prev-selective" ${r.selective ? 'checked' : ''}> selective</label>
                <label>order <input type="number" class="c2l-prev-order" value="${Number.isFinite(r.order) ? r.order : 100}" style="width:70px"></label>
                <label>probability <input type="number" class="c2l-prev-prob" min="0" max="100" value="${Number.isFinite(r.probability) ? r.probability : 100}" style="width:60px">%</label>
            </div>
        </div>
    `;
}

function renderStepDone(state, result) {
    return `
        <h3>Committed</h3>
        <p class="c2l-hint">Wrote to <b>${escapeHtml(result?.target || '?')}</b></p>
        <div class="c2l-progress-summary">
            <span><b>${result?.written || 0}</b> written</span>
            <span>${result?.appended || 0} appended</span>
            <span>${result?.overwritten || 0} overwritten</span>
            <span>${result?.skipped || 0} skipped</span>
        </div>
        <p class="c2l-hint">Click "Open lorebook" to inspect the entries in ST's World Info editor.</p>
    `;
}

/* ============================================================
 * Wizard runner
 * ============================================================ */

function attachStepHandlers(state, refresh) {
    const root = document.querySelector('.c2l-wizard');
    if (!root) return;

    if (state.currentStep === 'profile') {
        root.querySelector('#c2l-prof-select')?.addEventListener('change', (e) => {
            state.profileId = e.target.value;
            setSelectedProfile(state.profileId);
            refresh();
        });
        root.querySelector('#c2l-ai-select')?.addEventListener('change', (e) => {
            const profile = getProfile(state.profileId);
            if (profile) profile.aiConnectionProfile = e.target.value || '';
        });
    }

    if (state.currentStep === 'dest') {
        root.querySelectorAll('input[name="c2l-mode"]').forEach(r => {
            r.addEventListener('change', (e) => {
                state.destination.mode = e.target.value;
                refresh();
            });
        });
        root.querySelector('#c2l-dest-newname')?.addEventListener('input', (e) => {
            state.destination.name = e.target.value;
        });
        root.querySelector('#c2l-dest-chatname')?.addEventListener('input', (e) => {
            state.destination.name = e.target.value;
        });
        root.querySelector('#c2l-dest-existing')?.addEventListener('change', (e) => {
            state.destination.name = e.target.value;
        });
        root.querySelector('#c2l-dest-character')?.addEventListener('change', (e) => {
            state.destination.characterAvatar = e.target.value;
        });
        // Initial coercion: pre-fill destination.name from current selection
        const existingSel = root.querySelector('#c2l-dest-existing');
        if (state.destination.mode === 'existing' && existingSel) {
            state.destination.name = existingSel.value || '';
        }
        const charSel = root.querySelector('#c2l-dest-character');
        if (state.destination.mode === 'character' && charSel && !state.destination.characterAvatar) {
            state.destination.characterAvatar = charSel.value || '';
        }
        root.querySelector('#c2l-conflict')?.addEventListener('change', (e) => {
            state.conflictPolicy = e.target.value;
        });
        root.querySelector('#c2l-wipe-before')?.addEventListener('change', (e) => {
            state.wipeBeforeCommit = e.target.checked;
        });
    }

    if (state.currentStep === 'preview') {
        // Group-level Drop all / Restore all
        root.querySelectorAll('.c2l-group-drop').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const card = b.dataset.card;
                state.previewRows.forEach(r => { if (r.cardName === card) r.dropped = true; });
                refresh();
            });
        });
        root.querySelectorAll('.c2l-group-restore').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const card = b.dataset.card;
                state.previewRows.forEach(r => { if (r.cardName === card) r.dropped = false; });
                refresh();
            });
        });
        // Top-level bulk actions
        root.querySelectorAll('[data-bulk]').forEach(b => {
            b.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = b.dataset.bulk;
                if (action === 'drop-section') {
                    const section = b.dataset.section;
                    state.previewRows.forEach(r => {
                        if (String(r._origin?.section || '').toLowerCase() === section) r.dropped = true;
                    });
                    refresh();
                } else if (action === 'set-prob') {
                    const val = prompt('Set probability for all entries (0-100):', '100');
                    if (val === null) return;
                    const n = Math.max(0, Math.min(100, Number(val) || 100));
                    state.previewRows.forEach(r => {
                        r.probability = n;
                        r.useProbability = n < 100;
                    });
                    refresh();
                } else if (action === 'set-constant') {
                    state.previewRows.forEach(r => { r.constant = true; r.selective = false; });
                    refresh();
                } else if (action === 'set-selective') {
                    state.previewRows.forEach(r => { r.constant = false; r.selective = true; });
                    refresh();
                }
            });
        });
        root.querySelectorAll('.c2l-preview-row').forEach(rowEl => {
            const i = Number(rowEl.dataset.i);
            const r = state.previewRows[i];
            if (!r) return;
            rowEl.querySelector('.c2l-prev-name')?.addEventListener('input', (e) => { r.comment = e.target.value; });
            rowEl.querySelector('.c2l-prev-keys')?.addEventListener('input', (e) => {
                r.keys = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
            });
            rowEl.querySelector('.c2l-prev-skeys')?.addEventListener('input', (e) => {
                r.secondaryKeys = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
            });
            rowEl.querySelector('.c2l-prev-content')?.addEventListener('input', (e) => { r.content = e.target.value; });
            rowEl.querySelector('.c2l-prev-constant')?.addEventListener('change', (e) => { r.constant = e.target.checked; });
            rowEl.querySelector('.c2l-prev-selective')?.addEventListener('change', (e) => { r.selective = e.target.checked; });
            rowEl.querySelector('.c2l-prev-order')?.addEventListener('input', (e) => { r.order = Number(e.target.value) || 100; });
            rowEl.querySelector('.c2l-prev-prob')?.addEventListener('input', (e) => {
                const v = Math.max(0, Math.min(100, Number(e.target.value) || 100));
                r.probability = v;
                r.useProbability = v < 100;
            });
            rowEl.querySelector('.c2l-prev-drop')?.addEventListener('click', () => {
                r.dropped = !r.dropped;
                refresh();
            });
        });
    }
}

/* ============================================================
 * Queue runner
 * ============================================================ */

async function runQueue(state, refresh) {
    const profile = getProfile(state.profileId);
    state.queue = state.cards.map(() => ({
        status: 'queued',
        error: null,
        entries: null,
        t0: 0,
        t1: 0,
    }));
    state.abortController = new AbortController();
    const signal = state.abortController.signal;
    const delay = Math.max(0, Number(settings().queueDelayMs) || 0);
    const parallelism = Math.max(1, Math.min(8, Number(settings().queueParallelism) || 1));

    // Tick the running rows' elapsed time every second.
    const tickInterval = setInterval(() => {
        const anyRunning = state.queue.some(q => q.status === 'running');
        if (anyRunning) refresh();
    }, 1000);

    refresh();

    // Worker — pulls the next queued index and processes it. Multiple workers
    // run concurrently when parallelism > 1.
    let nextIdx = 0;
    const claimNext = () => {
        while (nextIdx < state.cards.length) {
            if (signal.aborted) return -1;
            const i = nextIdx++;
            if (state.queue[i].status === 'queued') return i;
        }
        return -1;
    };

    async function worker() {
        while (true) {
            const i = claimNext();
            if (i < 0) return;
            const { card } = state.cards[i];
            state.queue[i].status = 'running';
            state.queue[i].t0 = Date.now();
            refresh();

            if (!hasExtractableContent(card, profile)) {
                state.queue[i].status = 'skipped';
                state.queue[i].error = 'no extractable content';
                state.queue[i].t1 = Date.now();
                toastr.info(`${card.name}: no extractable content, skipped.`, 'Card to Lorebook');
                refresh();
                continue;
            }

            try {
                const entries = await convertOneCard(card, profile, signal);
                for (const entry of entries) {
                    const sectionLabel = entry._origin?.sectionLabel || '';
                    entry.comment = sectionLabel
                        ? makeCardStamp(card.name, '', sectionLabel)
                        : makeCardStamp(card.name, profile.name);
                }
                state.queue[i].entries = entries;
                state.queue[i].status = 'done';
            } catch (e) {
                if (e?.name === 'AbortError') {
                    state.queue[i].status = 'cancelled';
                } else {
                    state.queue[i].status = 'failed';
                    state.queue[i].error = String(e?.message || e);
                    err(`convert "${card.name}" failed`, e);
                }
            }
            state.queue[i].t1 = Date.now();
            refresh();

            if (delay > 0 && !signal.aborted) {
                await new Promise(res => setTimeout(res, delay));
            }
        }
    }

    try {
        const workers = Array.from({ length: parallelism }, () => worker());
        await Promise.all(workers);
        // Mark anything still queued as cancelled (only happens if abort fired).
        for (const q of state.queue) {
            if (q.status === 'queued') q.status = 'cancelled';
        }
    } finally {
        clearInterval(tickInterval);
    }

    // P2.15 cross-character relationship linking
    crossLinkRelationships(state);
}

/**
 * Detect bidirectional relationship mentions among the selected cards.
 * If Card A's "relationships" entry mentions Card B (in keys, secondaryKeys,
 * or content) AND vice versa, ensure each entry has the other card's name
 * in its primary keys. This makes the AND-gated relationships fire correctly.
 */
function crossLinkRelationships(state) {
    const namesSel = new Set(
        state.cards.map(c => String(c.card?.name || '').toLowerCase()).filter(Boolean),
    );

    // Pull all relationships entries per card.
    const relByCard = new Map(); // cardName(lower) -> entry
    for (let i = 0; i < state.queue.length; i++) {
        const q = state.queue[i];
        if (q.status !== 'done' || !Array.isArray(q.entries)) continue;
        const cardName = String(state.cards[i].card?.name || '').toLowerCase();
        if (!cardName) continue;
        const rel = q.entries.find(e => String(e._origin?.section || '').toLowerCase() === 'relationships');
        if (rel) relByCard.set(cardName, rel);
    }

    // For each pair of selected cards with rel entries, check bidirectional mention.
    const cardNames = [...relByCard.keys()];
    let linkedCount = 0;
    for (let i = 0; i < cardNames.length; i++) {
        for (let j = i + 1; j < cardNames.length; j++) {
            const a = cardNames[i];
            const b = cardNames[j];
            const ea = relByCard.get(a);
            const eb = relByCard.get(b);
            const aMentionsB = entryMentions(ea, b);
            const bMentionsA = entryMentions(eb, a);
            if (aMentionsB && bMentionsA) {
                ensureKeyPresent(ea, b);
                ensureKeyPresent(eb, a);
                linkedCount++;
            }
        }
    }
    if (linkedCount > 0) log(`crossLinkRelationships: linked ${linkedCount} bidirectional pair(s)`);
}

function entryMentions(entry, name) {
    if (!entry) return false;
    const lowerName = String(name || '').toLowerCase();
    const inKeys = (entry.keys || []).some(k => String(k).toLowerCase() === lowerName);
    const inSec = (entry.secondaryKeys || []).some(k => String(k).toLowerCase() === lowerName);
    const inContent = String(entry.content || '').toLowerCase().includes(lowerName);
    return inKeys || inSec || inContent;
}

function ensureKeyPresent(entry, name) {
    if (!entry) return;
    const lower = String(name || '').toLowerCase();
    const proper = name.replace(/\b\w/g, c => c.toUpperCase());
    if (!(entry.keys || []).some(k => String(k).toLowerCase() === lower)) {
        entry.keys = [...(entry.keys || []), proper];
    }
}

function buildPreviewRows(state) {
    const rows = [];

    // AI-generated entries (one in flat mode, many in modular mode).
    for (let i = 0; i < state.queue.length; i++) {
        const q = state.queue[i];
        if (q.status !== 'done' || !Array.isArray(q.entries)) continue;
        const card = state.cards[i].card;
        for (const e of q.entries) {
            const kind = e._origin?.section ? `card · ${e._origin.sectionLabel || e._origin.section}` : 'card';
            rows.push({
                kind,
                cardName: card.name,
                comment: e.comment,
                keys: e.keys || [],
                secondaryKeys: e.secondaryKeys || [],
                content: e.content,
                constant: !!e.constant,
                selective: e.selective !== false,
                order: e.order,
                position: e.position,
                probability: Number.isFinite(e.probability) ? e.probability : 100,
                useProbability: !!e.useProbability,
                _origin: e._origin,
                dropped: false,
            });
        }
    }

    // Embedded character_book entries.
    for (const { card } of state.cards) {
        const embedded = getEmbeddedBookEntries(card);
        for (const e of embedded) {
            rows.push({
                kind: 'embedded',
                cardName: card.name,
                comment: makeEmbeddedStamp(card.name, e.comment),
                keys: e.keys,
                secondaryKeys: e.secondaryKeys,
                content: e.content,
                constant: e.constant,
                selective: e.selective,
                order: e.order,
                position: e.position,
                probability: 100,
                useProbability: false,
                _origin: e._origin,
                dropped: false,
            });
        }
    }

    return rows;
}

/* ============================================================
 * Wizard entry point
 * ============================================================ */

export async function openWizard(selectedIds) {
    const state = newWizardState(selectedIds);
    if (state.cards.length === 0) {
        toastr.warning('No usable cards selected.', 'Card to Lorebook');
        return;
    }

    // Build the popup body. We re-render on every step transition.
    const root = document.createElement('div');
    root.className = 'c2l-wizard';

    let popup;
    let commitResult = null;

    function nextStepOf(s) {
        const i = STEPS.indexOf(s);
        return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : s;
    }

    function refresh() {
        root.innerHTML = `
            <div class="c2l-stepbar">${renderStepbar(state)}</div>
            <div class="c2l-body">${renderStepBody()}</div>
            <div class="c2l-actions">${renderActions()}</div>
        `;
        attachStepHandlers(state, refresh);
        attachActionHandlers();
    }

    function renderStepBody() {
        switch (state.currentStep) {
            case 'source':    return renderStepSource(state);
            case 'profile':   return renderStepProfile(state);
            case 'dest':      return renderStepDest(state);
            case 'preflight': return renderStepPreflight(state);
            case 'progress':  return renderStepProgress(state);
            case 'preview':   return renderStepPreview(state);
            case 'done':      return renderStepDone(state, commitResult);
            default: return '';
        }
    }

    function renderActions() {
        switch (state.currentStep) {
            case 'source':
                return `
                    <button type="button" class="menu_button" data-act="cancel">Cancel</button>
                    <button type="button" class="menu_button" data-act="next">Next</button>
                `;
            case 'profile':
                return `
                    <button type="button" class="menu_button" data-act="back">Back</button>
                    <button type="button" class="menu_button" data-act="next">Next</button>
                `;
            case 'dest':
                return `
                    <button type="button" class="menu_button" data-act="back">Back</button>
                    <button type="button" class="menu_button" data-act="next">Next</button>
                `;
            case 'preflight':
                return `
                    <button type="button" class="menu_button" data-act="back">Back</button>
                    <button type="button" class="menu_button" data-act="start">Start</button>
                `;
            case 'progress':
                return `
                    <button type="button" class="menu_button danger" data-act="cancelqueue">Cancel queue</button>
                `;
            case 'preview':
                return `
                    <button type="button" class="menu_button" data-act="discard">Discard all</button>
                    <button type="button" class="menu_button" data-act="commit">Commit</button>
                `;
            case 'done':
                return `
                    <button type="button" class="menu_button" data-act="open">Open lorebook</button>
                    <button type="button" class="menu_button" data-act="close">Close</button>
                `;
        }
        return '';
    }

    function attachActionHandlers() {
        root.querySelectorAll('[data-act]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const act = btn.dataset.act;
                if (act === 'cancel' || act === 'close') {
                    popup?.complete(POPUP_RESULT.AFFIRMATIVE);
                    return;
                }
                if (act === 'back') {
                    const i = STEPS.indexOf(state.currentStep);
                    state.currentStep = STEPS[Math.max(0, i - 1)];
                    refresh();
                    return;
                }
                if (act === 'next') {
                    // Validate before advance
                    if (state.currentStep === 'dest') {
                        if (!validateDestination(state)) return;
                    }
                    state.currentStep = nextStepOf(state.currentStep);
                    refresh();
                    return;
                }
                if (act === 'start') {
                    state.currentStep = 'progress';
                    refresh();
                    try {
                        await runQueue(state, refresh);
                    } finally {
                        // Auto-advance to preview when queue completes.
                        state.previewRows = buildPreviewRows(state);
                        state.currentStep = 'preview';
                        refresh();
                        try {
                            const { eventSource } = await import('/script.js');
                            await eventSource.emit('cards-to-lore.queue.done', {
                                cards: state.cards.map(c => c.card?.name),
                                profileId: state.profileId,
                                results: state.queue.map(q => ({
                                    status: q.status,
                                    entriesCount: q.entries?.length || 0,
                                    error: q.error,
                                })),
                            });
                        } catch (e) { /* ignore */ }
                    }
                    return;
                }
                if (act === 'cancelqueue') {
                    state.abortController?.abort();
                    return;
                }
                if (act === 'discard') {
                    popup?.complete(POPUP_RESULT.AFFIRMATIVE);
                    return;
                }
                if (act === 'commit') {
                    const entries = state.previewRows
                        .filter(r => !r.dropped)
                        .map(rowToInternalEntry);
                    if (entries.length === 0) {
                        toastr.info('Nothing to commit — all entries dropped.', 'Card to Lorebook');
                        return;
                    }
                    btn.disabled = true;
                    btn.textContent = 'Committing…';
                    try {
                        // P1.12 redo-from-scratch: wipe existing card2lore stamps in the
                        // target lorebook first (only meaningful for existing/chat destinations).
                        if (state.wipeBeforeCommit && (state.destination.mode === 'existing' || state.destination.mode === 'chat')) {
                            const bookName = state.destination.name;
                            if (bookName) {
                                try {
                                    const removed = await removeStampedEntries(bookName);
                                    if (removed > 0) {
                                        toastr.info(`Removed ${removed} existing card2lore entries from ${bookName}.`, 'Card to Lorebook');
                                    }
                                } catch (e) {
                                    warn('wipe-before-commit failed', e);
                                }
                            }
                        }
                        commitResult = await commitEntries(state.destination, entries, state.conflictPolicy);
                        state.currentStep = 'done';
                        refresh();
                        toastr.success(`Wrote ${commitResult.written} entries to ${commitResult.target}.`, 'Card to Lorebook');
                        // P2.18 event emission
                        try {
                            const { eventSource } = await import('/script.js');
                            await eventSource.emit('cards-to-lore.committed', {
                                destination: state.destination,
                                result: commitResult,
                                entriesCount: entries.length,
                            });
                        } catch (e) { /* ignore */ }
                    } catch (e) {
                        err('Commit failed', e);
                        toastr.error(String(e?.message || e), 'Commit failed');
                        btn.disabled = false;
                        btn.textContent = 'Commit';
                    }
                    return;
                }
                if (act === 'open') {
                    if (commitResult?.target) {
                        // Strip any "(bound to chat)" suffix added by lorebookIO.
                        const bookName = commitResult.target.replace(/\s*\(bound to chat\)$/, '').trim();
                        openWorldInfoEditor(bookName);
                    }
                    popup?.complete(POPUP_RESULT.AFFIRMATIVE);
                    return;
                }
            });
        });
    }

    refresh();
    popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: false,
        cancelButton: false,
        allowVerticalScrolling: true,
    });
    await popup.show();
}

function validateDestination(state) {
    const m = state.destination.mode;
    if (m === 'new' || m === 'chat') {
        const name = String(state.destination.name || '').trim();
        if (!name) { toastr.warning('Lorebook name is required.', 'Card to Lorebook'); return false; }
        state.destination.name = name;
        return true;
    }
    if (m === 'existing') {
        if (!state.destination.name) {
            // Take whatever is in the dropdown
            const sel = document.getElementById('c2l-dest-existing');
            if (sel?.value) state.destination.name = sel.value;
        }
        if (!state.destination.name) { toastr.warning('Pick an existing lorebook.', 'Card to Lorebook'); return false; }
        return true;
    }
    if (m === 'character') {
        if (!state.destination.characterAvatar) {
            const sel = document.getElementById('c2l-dest-character');
            if (sel?.value) state.destination.characterAvatar = sel.value;
        }
        if (!state.destination.characterAvatar) { toastr.warning('Pick a target character.', 'Card to Lorebook'); return false; }
        return true;
    }
    return false;
}

function rowToInternalEntry(row) {
    const probability = Number.isFinite(row.probability) ? Math.max(0, Math.min(100, row.probability)) : 100;
    return {
        keys: row.keys || [],
        secondaryKeys: row.secondaryKeys || [],
        content: row.content || '',
        comment: row.comment || '',
        constant: !!row.constant,
        selective: row.selective !== false,
        order: Number.isFinite(row.order) ? row.order : 100,
        position: Number.isFinite(row.position) ? row.position : 0,
        probability,
        useProbability: probability < 100,
        _origin: row._origin || null,
    };
}
