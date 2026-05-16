/**
 * Lorebook I/O — wraps ST's world-info module for the four destination modes:
 *   - new    : create a fresh lorebook file
 *   - existing: append/update entries in an existing global lorebook
 *   - chat   : bind a lorebook to the current chat (chat_metadata.world_info)
 *   - character: write into a specific character's embedded character_book
 *
 * Also handles the conflict policy (skip / overwrite / append-as-new / ask)
 * when writing into an existing book.
 */

import {
    METADATA_KEY as WI_METADATA_KEY,
    createNewWorldInfo,
    createWorldInfoEntry,
    loadWorldInfo,
    saveWorldInfo,
    updateWorldInfoList,
    world_names,
} from '/scripts/world-info.js';
import {
    chat_metadata,
    characters,
    getRequestHeaders,
    saveMetadata,
    saveSettingsDebounced,
} from '/script.js';
import { Popup, POPUP_TYPE } from '/scripts/popup.js';

import {
    ENTRY_STAMP_CARD,
    ENTRY_STAMP_EMBEDDED,
    log, warn, err,
} from './core.js';

/* ============================================================
 * Globals (UI helpers)
 * ============================================================ */

export function listAllWorlds() {
    return Array.isArray(world_names) ? [...world_names] : [];
}

/* ============================================================
 * Lorebook loading / creating
 * ============================================================ */

async function loadOrInit(name) {
    let data = await loadWorldInfo(name);
    if (!data || typeof data !== 'object') data = { entries: {} };
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};
    return data;
}

export async function ensureNewLorebook(name) {
    const ok = await createNewWorldInfo(name, { interactive: false });
    if (!ok) throw new Error(`Failed to create lorebook "${name}" (name conflict or invalid).`);
    return name;
}

/* ============================================================
 * Entry shape conversion
 * ============================================================ */

/**
 * Convert our internal entry shape (from cardExtractor or conversionEngine)
 * into a proper ST world-info entry attached to `data.entries[uid]`. Returns
 * the new entry object (with assigned uid).
 *
 * @param {object} data            world-info data blob (mutated)
 * @param {object} entry           internal entry shape (see below)
 * @returns {object} the created ST entry
 *
 * Internal entry shape:
 *   {
 *     keys: string[],
 *     secondaryKeys?: string[],
 *     content: string,
 *     comment: string,
 *     constant?: boolean,
 *     selective?: boolean,
 *     order?: number,
 *     position?: number,
 *     _origin?: { source, cardName, profileId?, createdAt? }
 *   }
 */
function addEntryToData(data, entry) {
    const created = createWorldInfoEntry(null, data);
    if (!created) throw new Error('createWorldInfoEntry returned null');
    created.key = [...(entry.keys || [])].filter(Boolean);
    created.keysecondary = [...(entry.secondaryKeys || [])].filter(Boolean);
    created.content = String(entry.content || '');
    created.comment = String(entry.comment || '');
    created.constant = !!entry.constant;
    created.selective = !!entry.selective;
    if (Number.isFinite(entry.order))           created.order = entry.order;
    if (Number.isFinite(entry.position))        created.position = entry.position;
    if (Number.isFinite(entry.probability))     created.probability = entry.probability;
    if (typeof entry.useProbability === 'boolean') created.useProbability = entry.useProbability;
    if (Number.isFinite(entry.depth))           created.depth = entry.depth;
    if (Number.isFinite(entry.selectiveLogic))  created.selectiveLogic = entry.selectiveLogic;
    if (typeof entry.disable === 'boolean')     created.disable = entry.disable;
    if (typeof entry.caseSensitive === 'boolean') created.caseSensitive = entry.caseSensitive;
    if (typeof entry.matchWholeWords === 'boolean') created.matchWholeWords = entry.matchWholeWords;
    if (entry._origin) {
        // ST entries don't have a typed metadata slot; keep our origin info
        // as a side-channel on the entry for in-memory reads (the comment
        // stamp is the persisted identifier).
        created._c2lOrigin = entry._origin;
    }
    return created;
}

/* ============================================================
 * Comment stamp helpers — distinguish our entries from hand-written ones
 * ============================================================ */

/**
 * Build the comment stamp for a card-derived entry. In modular mode, pass the
 * section label so each sub-entry has its own collision key — overwriting
 * "Arika - Appearance" leaves "Arika - Voice" alone.
 *
 * Examples:
 *   makeCardStamp('Arika')                    → "[card2lore:card] Arika"
 *   makeCardStamp('Arika', '', 'Appearance')  → "[card2lore:card:Appearance] Arika"
 *   makeCardStamp('Arika', 'RP Default')      → "[card2lore:card:RP Default] Arika"
 */
export function makeCardStamp(cardName, profileNameOrLabel = '', section = '') {
    const tag = section
        ? `[${ENTRY_STAMP_CARD}:${section}]`
        : (profileNameOrLabel
            ? `[${ENTRY_STAMP_CARD}:${profileNameOrLabel}]`
            : `[${ENTRY_STAMP_CARD}]`);
    return `${tag} ${cardName || 'unknown'}`;
}

export function makeEmbeddedStamp(cardName, originalComment = '') {
    const head = `[${ENTRY_STAMP_EMBEDDED}] ${cardName || 'unknown'}`;
    return originalComment ? `${head} — ${originalComment}` : head;
}

/**
 * Stamp for a non-character world entity extracted from a card.
 *   makeEntityStamp('location', 'Royal Palace')  → "[card2lore:location] Royal Palace"
 *   makeEntityStamp('item', 'Excalibur')         → "[card2lore:item] Excalibur"
 *
 * Entity stamps don't include the parent card name in the comment — the
 * entity is treated as a first-class noun that may be re-extracted from
 * multiple cards (collision resolution handles dedup).
 */
export function makeEntityStamp(entityType, entityName) {
    const t = String(entityType || 'concept').toLowerCase();
    const n = String(entityName || 'unknown').trim();
    return `[${ENTRY_STAMP_CARD}:${t}] ${n}`;
}

/** True if the entry was stamped by us (any kind). */
export function isStampedByUs(entry) {
    const c = String(entry?.comment || '');
    return c.includes(`[${ENTRY_STAMP_CARD}`) || c.includes(`[${ENTRY_STAMP_EMBEDDED}`);
}

/**
 * Find an existing entry in `data.entries` whose comment EXACTLY matches the
 * given stamp. We can't use `startsWith` — `[card2lore:card:Anchor] Arika`
 * would prefix-match `[card2lore:card:Anchor] Arika and Friends`. Instead we
 * compare the full stamp up to a terminator (end-of-string, comma, or em
 * dash for embedded entries that suffix the original name).
 */
function findCollidingEntry(data, fullStamp) {
    if (!data?.entries) return null;
    const norm = String(fullStamp || '').trim();
    if (!norm) return null;
    for (const [uid, entry] of Object.entries(data.entries)) {
        const comment = String(entry?.comment || '').trim();
        if (!comment) continue;
        if (comment === norm) return { uid: Number(uid), entry };
        // Embedded stamp form: "[card2lore:embedded] CardName — OriginalName"
        // Match if the prefix up to the em dash equals our stamp.
        const head = comment.split(' — ')[0].trim();
        if (head === norm) return { uid: Number(uid), entry };
    }
    return null;
}

/* ============================================================
 * Conflict resolution
 * ============================================================ */

/**
 * Resolve a single conflict according to policy. Returns one of:
 *   'skip'        — drop the new entry, leave existing
 *   'overwrite'   — replace existing entry's content
 *   'append'      — add as new entry (suffixed name)
 *
 * For 'ask' policy, opens a per-entry popup.
 */
async function resolveConflict(policy, cardName, existingEntry, newEntry) {
    if (policy === 'skip' || policy === 'overwrite' || policy === 'append') return policy;
    if (policy !== 'ask') return 'skip';

    const html = `
        <div style="display:flex; flex-direction:column; gap:8px; min-width:520px;">
            <h3 style="margin:0">Entry conflict: <code>${cardName}</code></h3>
            <p style="margin:0; opacity:0.75; font-size:0.9em;">An entry stamped for this card already exists in the target lorebook. How do you want to handle it?</p>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:0.85em;">
                <div>
                    <b>Existing</b>
                    <textarea readonly rows="10" style="width:100%;">${escapeHtml(existingEntry.content || '')}</textarea>
                </div>
                <div>
                    <b>New</b>
                    <textarea readonly rows="10" style="width:100%;">${escapeHtml(newEntry.content || '')}</textarea>
                </div>
            </div>
        </div>`;
    const result = await new Popup(html, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: false,
        okButton: 'Overwrite',
        cancelButton: 'Skip',
        customButtons: [
            { text: 'Append as new', result: 'append' },
            { text: 'Skip', result: 'skip' },
            { text: 'Overwrite', result: 'overwrite' },
        ],
    }).show();
    if (result === 'overwrite' || result === 'append' || result === 'skip') return result;
    return 'skip';
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ============================================================
 * Main write flow
 * ============================================================ */

/**
 * Write a batch of entries to the resolved destination.
 *
 * @param {object} destination  { mode: 'new'|'existing'|'chat'|'character', name?, characterAvatar? }
 * @param {object[]} entries    array of internal entry shapes
 * @param {string} conflictPolicy  'ask' | 'skip' | 'overwrite' | 'append'
 * @returns {Promise<{ written: number, skipped: number, overwritten: number, appended: number, target: string }>}
 */
export async function commitEntries(destination, entries, conflictPolicy = 'ask') {
    if (!Array.isArray(entries) || entries.length === 0) {
        return { written: 0, skipped: 0, overwritten: 0, appended: 0, target: '' };
    }

    const result = { written: 0, skipped: 0, overwritten: 0, appended: 0, target: '' };

    if (destination.mode === 'new') {
        if (!destination.name) throw new Error('New lorebook destination needs a name');
        await ensureNewLorebook(destination.name);
        result.target = destination.name;
        await appendToWorld(destination.name, entries, 'append', result);
        return result;
    }

    if (destination.mode === 'existing') {
        if (!destination.name) throw new Error('Existing lorebook destination needs a name');
        result.target = destination.name;
        await appendToWorld(destination.name, entries, conflictPolicy, result);
        return result;
    }

    if (destination.mode === 'chat') {
        // Bind a (possibly new) lorebook to this chat via chat_metadata.
        const bookName = destination.name || '';
        if (!bookName) throw new Error('Chat destination needs a lorebook name');
        if (!world_names?.includes(bookName)) {
            await ensureNewLorebook(bookName);
        }
        result.target = `${bookName} (bound to chat)`;
        await appendToWorld(bookName, entries, conflictPolicy, result);
        // Bind to chat
        chat_metadata[WI_METADATA_KEY] = bookName;
        try { await saveMetadata(); } catch (e) { warn('saveMetadata failed', e); }
        return result;
    }

    if (destination.mode === 'character') {
        // Write into the character's embedded character_book and POST to
        // /api/characters/merge-attributes so it persists immediately.
        if (!destination.characterAvatar) throw new Error('Character destination needs an avatar');
        const charIdx = characters.findIndex(c => c?.avatar === destination.characterAvatar);
        if (charIdx === -1) throw new Error('Target character not found');
        const char = characters[charIdx];
        char.data = char.data || {};
        const book = char.data.character_book || { entries: [], name: char.name };
        char.data.character_book = book;
        book.entries = Array.isArray(book.entries) ? book.entries : [];

        for (const entry of entries) {
            const v2 = internalToV2BookEntry(entry, book.entries.length);
            book.entries.push(v2);
            result.appended++;
            result.written++;
        }
        result.target = `${char.name}'s character book`;

        // Persist via merge-attributes — sends only character_book, server
        // merges into the card on disk. No need to reload all characters.
        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: char.avatar,
                    data: { character_book: book },
                }),
            });
            if (!response.ok) {
                throw new Error(`merge-attributes returned ${response.status}`);
            }
            log(`Character book persisted via merge-attributes for ${char.name}`);
        } catch (e) {
            err('character destination persistence failed', e);
            throw new Error(`Failed to save character book to disk: ${e.message}. In-memory copy is still set.`);
        }
        saveSettingsDebounced();
        return result;
    }

    throw new Error(`Unknown destination mode: ${destination.mode}`);
}

/**
 * Internal shape → V2 character_book entry shape.
 */
function internalToV2BookEntry(entry, insertionOrder) {
    return {
        keys: entry.keys || [],
        content: entry.content || '',
        extensions: {},
        enabled: true,
        insertion_order: Number.isFinite(entry.order) ? entry.order : (100 + insertionOrder),
        name: entry.comment || (entry.keys?.[0] ?? 'Entry'),
        comment: entry.comment || '',
        case_sensitive: false,
        secondary_keys: entry.secondaryKeys || [],
        constant: !!entry.constant,
        selective: !!entry.selective,
        position: entry.position === 1 ? 'after_char' : 'before_char',
    };
}

/**
 * Core append/update routine — for global lorebooks (modes 'new', 'existing',
 * 'chat'). Mutates the `result` object in place.
 */
async function appendToWorld(worldName, entries, policy, result) {
    const data = await loadOrInit(worldName);
    let dirty = false;

    for (const entry of entries) {
        const stamp = String(entry.comment || '').replace(/\s+—.*$/, '').trim();
        const collision = stamp ? findCollidingEntry(data, stamp) : null;

        if (!collision) {
            addEntryToData(data, entry);
            result.appended++;
            result.written++;
            dirty = true;
            continue;
        }

        const cardName = String(entry._origin?.cardName || stamp);
        const decision = await resolveConflict(policy, cardName, collision.entry, entry);

        if (decision === 'skip') {
            result.skipped++;
            continue;
        }
        if (decision === 'overwrite') {
            // Replace in place, preserving the existing UID and ordering.
            const old = data.entries[collision.uid];
            old.key = [...(entry.keys || [])].filter(Boolean);
            old.keysecondary = [...(entry.secondaryKeys || [])].filter(Boolean);
            old.content = String(entry.content || '');
            old.comment = String(entry.comment || '');
            old.constant = !!entry.constant;
            old.selective = !!entry.selective;
            if (Number.isFinite(entry.order))           old.order = entry.order;
            if (Number.isFinite(entry.position))        old.position = entry.position;
            if (Number.isFinite(entry.probability))     old.probability = entry.probability;
            if (typeof entry.useProbability === 'boolean') old.useProbability = entry.useProbability;
            if (Number.isFinite(entry.depth))           old.depth = entry.depth;
            if (Number.isFinite(entry.selectiveLogic))  old.selectiveLogic = entry.selectiveLogic;
            old._c2lOrigin = entry._origin;
            result.overwritten++;
            result.written++;
            dirty = true;
            continue;
        }
        if (decision === 'append') {
            // Suffix the comment to disambiguate.
            const suffixed = { ...entry, comment: `${entry.comment} (copy)` };
            addEntryToData(data, suffixed);
            result.appended++;
            result.written++;
            dirty = true;
            continue;
        }
    }

    if (dirty) {
        await saveWorldInfo(worldName, data, true);
        await updateWorldInfoList();
    }
    log(`appendToWorld(${worldName}) →`, result);
}

/* ============================================================
 * Bulk-remove-by-stamp (Phase 3 cleanup utility)
 * ============================================================ */

/**
 * Remove every entry in `worldName` whose comment carries our card2lore
 * stamp. Useful for "re-run the conversion from scratch" scenarios.
 *
 * @returns {Promise<number>} how many entries were removed
 */
export async function removeStampedEntries(worldName) {
    const data = await loadOrInit(worldName);
    let removed = 0;
    for (const [uid, entry] of Object.entries(data.entries)) {
        if (isStampedByUs(entry)) {
            delete data.entries[uid];
            removed++;
        }
    }
    if (removed > 0) {
        await saveWorldInfo(worldName, data, true);
        await updateWorldInfoList();
    }
    return removed;
}

/* ============================================================
 * Open lorebook in ST's UI (post-commit convenience)
 * ============================================================ */

export function openWorldInfoEditor(worldName) {
    try {
        // Open the WI drawer if closed.
        const drawer = document.getElementById('WIDrawerOpenButton');
        if (drawer && !document.getElementById('world_popup_entries_list')) {
            drawer.click();
        }
        const select = document.getElementById('world_editor_select');
        if (!select) return false;
        const idx = world_names.indexOf(worldName);
        if (idx === -1) return false;
        select.value = idx;
        select.dispatchEvent(new Event('change'));
        return true;
    } catch (e) {
        err('openWorldInfoEditor failed', e);
        return false;
    }
}
