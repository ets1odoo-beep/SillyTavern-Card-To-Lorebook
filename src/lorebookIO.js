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
    ENTRY_STAMP_ROSTER,
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
function applyFieldsToEntry(target, entry) {
    target.key = [...(entry.keys || [])].filter(Boolean);
    target.keysecondary = [...(entry.secondaryKeys || [])].filter(Boolean);
    // Inject content decorators (@@activate <name>) for cross-references the
    // AI flagged so anchor entries cross-trigger related sections without
    // keys needing to overlap.
    const linkedTo = entry?._origin?.linkedTo;
    if (Array.isArray(linkedTo) && linkedTo.length > 0) {
        const decorators = linkedTo
            .map(n => `@@activate ${String(n).trim()}`)
            .filter(Boolean)
            .join('\n');
        target.content = decorators
            ? `${decorators}\n${String(entry.content || '')}`
            : String(entry.content || '');
    } else {
        target.content = String(entry.content || '');
    }
    target.comment = String(entry.comment || '');
    target.constant = !!entry.constant;
    target.selective = !!entry.selective;
    if (Number.isFinite(entry.order))           target.order = entry.order;
    if (Number.isFinite(entry.position))        target.position = entry.position;
    if (Number.isFinite(entry.depth))           target.depth = entry.depth;
    if (Number.isFinite(entry.probability))     target.probability = entry.probability;
    if (typeof entry.useProbability === 'boolean') target.useProbability = entry.useProbability;
    if (Number.isFinite(entry.selectiveLogic))  target.selectiveLogic = entry.selectiveLogic;
    if (typeof entry.disable === 'boolean')     target.disable = entry.disable;
    if (typeof entry.caseSensitive === 'boolean') target.caseSensitive = entry.caseSensitive;
    if (typeof entry.matchWholeWords === 'boolean') target.matchWholeWords = entry.matchWholeWords;
    // Phase B — extended WI field surface
    if (Number.isFinite(entry.scanDepth))       target.scanDepth = entry.scanDepth;
    if (typeof entry.vectorized === 'boolean')  target.vectorized = entry.vectorized;
    if (typeof entry.excludeRecursion === 'boolean') target.excludeRecursion = entry.excludeRecursion;
    if (typeof entry.preventRecursion === 'boolean') target.preventRecursion = entry.preventRecursion;
    if (Number.isFinite(entry.delayUntilRecursion)) target.delayUntilRecursion = entry.delayUntilRecursion;
    if (Number.isFinite(entry.sticky))          target.sticky = entry.sticky;
    if (Number.isFinite(entry.cooldown))        target.cooldown = entry.cooldown;
    if (Number.isFinite(entry.delay))           target.delay = entry.delay;
    if (typeof entry.group === 'string' && entry.group) target.group = entry.group;
    if (typeof entry.groupOverride === 'boolean') target.groupOverride = entry.groupOverride;
    if (Number.isFinite(entry.groupWeight))     target.groupWeight = entry.groupWeight;
    if (typeof entry.useGroupScoring === 'boolean') target.useGroupScoring = entry.useGroupScoring;
    if (typeof entry.automationId === 'string' && entry.automationId) target.automationId = entry.automationId;
    if (typeof entry.ignoreBudget === 'boolean') target.ignoreBudget = entry.ignoreBudget;
    if (Array.isArray(entry.triggers))          target.triggers = [...entry.triggers];
    if (entry._origin) target._c2lOrigin = entry._origin;
    return target;
}

function addEntryToData(data, entry) {
    const created = createWorldInfoEntry(null, data);
    if (!created) throw new Error('createWorldInfoEntry returned null');
    return applyFieldsToEntry(created, entry);
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
    if (policy === 'skip' || policy === 'overwrite' || policy === 'append' || policy === 'merge') return policy;
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
            { text: 'Merge (AI)', result: 'merge' },
            { text: 'Append as new', result: 'append' },
            { text: 'Skip', result: 'skip' },
            { text: 'Overwrite', result: 'overwrite' },
        ],
    }).show();
    if (['merge', 'overwrite', 'append', 'skip'].includes(result)) return result;
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
export async function commitEntries(destination, entries, conflictPolicy = 'ask', opts = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return { written: 0, skipped: 0, overwritten: 0, appended: 0, merged: 0, mergeCallsUsed: 0, target: '' };
    }

    const result = {
        written: 0, skipped: 0, overwritten: 0, appended: 0, merged: 0,
        mergeCallsUsed: 0, target: '',
    };
    const mergeProfile = opts.mergeProfile || null;
    const mergeCap = opts.mergeMaxAiCalls ?? 20;

    if (destination.mode === 'new') {
        if (!destination.name) throw new Error('New lorebook destination needs a name');
        await ensureNewLorebook(destination.name);
        result.target = destination.name;
        await appendToWorld(destination.name, entries, 'append', result, mergeProfile, mergeCap);
        return result;
    }

    if (destination.mode === 'existing') {
        if (!destination.name) throw new Error('Existing lorebook destination needs a name');
        result.target = destination.name;
        await appendToWorld(destination.name, entries, conflictPolicy, result, mergeProfile, mergeCap);
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
        await appendToWorld(bookName, entries, conflictPolicy, result, mergeProfile, mergeCap);
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
        key: entry.keys || [],
        content: entry.content || '',
        extensions: {
            depth: Number.isFinite(entry.depth) ? entry.depth : undefined,
            useProbability: !!entry.useProbability,
            excludeRecursion: !!entry.excludeRecursion,
            weight: Number.isFinite(entry.groupWeight) ? entry.groupWeight : undefined,
        },
        enabled: true,
        insertion_order: Number.isFinite(entry.order) ? entry.order : (100 + insertionOrder),
        order: Number.isFinite(entry.order) ? entry.order : (100 + insertionOrder),
        name: entry.comment || (entry.keys?.[0] ?? 'Entry'),
        comment: entry.comment || '',
        case_sensitive: false,
        secondary_keys: entry.secondaryKeys || [],
        keysecondary: entry.secondaryKeys || [],
        constant: !!entry.constant,
        selective: !!entry.selective,
        selectiveLogic: Number.isFinite(entry.selectiveLogic) ? entry.selectiveLogic : 0,
        position: Number.isFinite(entry.position) ? entry.position : 0,
        depth: Number.isFinite(entry.depth) ? entry.depth : null,
        probability: Number.isFinite(entry.probability) ? entry.probability : 100,
        useProbability: !!entry.useProbability,
        scanDepth: Number.isFinite(entry.scanDepth) ? entry.scanDepth : null,
        matchWholeWords: typeof entry.matchWholeWords === 'boolean' ? entry.matchWholeWords : null,
        vectorized: !!entry.vectorized,
        excludeRecursion: !!entry.excludeRecursion,
        sticky: Number.isFinite(entry.sticky) ? entry.sticky : null,
        cooldown: Number.isFinite(entry.cooldown) ? entry.cooldown : null,
        group: entry.group || '',
        groupWeight: Number.isFinite(entry.groupWeight) ? entry.groupWeight : null,
        ignoreBudget: !!entry.ignoreBudget,
    };
}

/**
 * Core append/update routine — for global lorebooks (modes 'new', 'existing',
 * 'chat'). Mutates the `result` object in place.
 */
async function appendToWorld(worldName, entries, policy, result, mergeProfile = null, mergeCap = 20) {
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
            applyFieldsToEntry(data.entries[collision.uid], entry);
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
        if (decision === 'merge') {
            // AI-merge: union the facts via a focused AI call, write back into
            // the existing entry's slot. Honors profile.mergeMaxAiCalls cap.
            if (result.mergeCallsUsed >= (mergeCap ?? 20)) {
                warn('mergeMaxAiCalls cap reached — falling back to skip');
                result.skipped++;
                continue;
            }
            try {
                const { mergeEntriesViaAI } = await import('./conversionEngine.js');
                const merged = await mergeEntriesViaAI(collision.entry, entry, mergeProfile || {});
                applyFieldsToEntry(data.entries[collision.uid], merged);
                result.merged++;
                result.written++;
                result.mergeCallsUsed++;
                dirty = true;
            } catch (e) {
                warn('AI merge failed — falling back to skip', e);
                result.skipped++;
            }
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

/* ============================================================
 * Roster — constant-true table-of-contents entry that lists every
 * card2lore-stamped item in the book so the AI knows what world it's in
 * even when no specific entry has fired yet.
 * ============================================================ */

export function makeRosterStamp() {
    return `[${ENTRY_STAMP_ROSTER}] World Roster`;
}

// Hard budget cap on roster content (chars). ~600 tokens worth.
const ROSTER_CHAR_BUDGET = 2400;

/**
 * Walk the lorebook's entries, group the card2lore-stamped ones by type, mine
 * cross-references via _c2lOrigin.linkedTo, and synthesize a navigable
 * cross-referenced index suitable for a constant-true always-on WI entry.
 *
 * Output shape:
 *   ## ACTIVE WORLD ROSTER (Card to Lorebook auto-generated — always loaded)
 *
 *   [MAIN CHARACTERS]
 *   • Arika — adult female human, magic warrior
 *     ↔ Vaaj Church · Royal Palace · Excalibur
 *   • ETSVin — adult male human, hero
 *
 *   [SUPPORTING]
 *   • King Verros — antagonist ruler  (↔ Royal Court · Royal Palace)
 *
 *   [LOCATIONS]
 *   • Royal Palace — capital seat
 *
 *   [FACTIONS]
 *   • Vaaj Church — state religion
 *
 *   [QUESTS — ACTIVE]
 *   • Defeat the Demon Lord — main arc
 *
 *   [RULES / WORLD FACTS]
 *   • Polygamy for adventurers is legal
 *
 *   ... etc
 *
 * Importance is derived from each character's anchor `_c2lOrigin.importance`
 * (set by the conversion engine), not from the `constant` flag.
 */
function buildRosterText(data) {
    // Collected per-type buckets.
    const chars = {
        main: [], supporting: [], minor: [],
    };
    const types = {
        location: [], faction: [], item: [],
        quest: [], event: [], document: [], rule: [],
        concept: [], language: [], culture: [],
        ability: [], rank_title: [], scene: [],
    };

    // Map characterName.toLowerCase() → { name, tag, importance, edges:Set }
    // built up from all of that character's sub-entries.
    const charMap = new Map();
    const ensureChar = (name) => {
        const k = name.toLowerCase();
        if (!charMap.has(k)) charMap.set(k, { name, tag: '', importance: 'supporting', edges: new Set() });
        return charMap.get(k);
    };

    for (const [_uid, entry] of Object.entries(data?.entries || {})) {
        const comment = String(entry?.comment || '').trim();
        if (!comment.startsWith('[card2lore:')) continue;
        if (comment.startsWith(`[${ENTRY_STAMP_ROSTER}]`)) continue;
        // Embedded passthrough entries deliberately skipped (have their own keys).

        const m = comment.match(/^\[card2lore:([a-z_]+)(?::([^\]]+))?\]\s*(.+?)(?:\s+—\s+.*)?$/i);
        if (!m) continue;
        const kind = m[1].toLowerCase();
        const subSection = (m[2] || '').toLowerCase();
        const name = m[3].trim();
        if (!name) continue;
        const origin = entry._c2lOrigin || {};
        const linkedTo = Array.isArray(origin.linkedTo) ? origin.linkedTo : [];

        if (kind === 'card') {
            // Per-character info accumulated from all sub-entries.
            const c = ensureChar(name);
            if (subSection === 'anchor') {
                c.tag = oneLineTag(entry.content, 70);
                if (origin.importance) c.importance = origin.importance;
            }
            // Every sub-entry's linkedTo (especially relationships) contributes
            // to the edges set.
            linkedTo.forEach(t => c.edges.add(t));
            continue;
        }

        const bucket = types[kind];
        if (!bucket) continue; // unknown type, skip
        // Single entry per non-character entity. Dedup by name.
        if (bucket.some(b => b.name.toLowerCase() === name.toLowerCase())) continue;
        bucket.push({
            name,
            tag: oneLineTag(entry.content, 60),
            disabled: !!entry.disable,
            edges: new Set(linkedTo),
        });
    }

    // Split characters by importance.
    for (const c of charMap.values()) {
        chars[c.importance === 'main' ? 'main' : c.importance === 'minor' ? 'minor' : 'supporting'].push(c);
    }

    // Render functions.
    const renderCharLine = (c) => {
        const edges = [...c.edges].slice(0, 6);
        const edgeLine = edges.length ? `\n    ↔ ${edges.join(' · ')}` : '';
        return c.tag
            ? `• ${c.name} — ${c.tag}${edgeLine}`
            : `• ${c.name}${edgeLine}`;
    };
    const renderEntityLine = (e) => {
        const edges = [...e.edges].slice(0, 4);
        const edgeLine = edges.length ? `  (↔ ${edges.join(' · ')})` : '';
        return e.tag ? `• ${e.name} — ${e.tag}${edgeLine}` : `• ${e.name}${edgeLine}`;
    };

    const sections = [];
    const pushSection = (heading, items, renderer) => {
        if (!items.length) return;
        sections.push(`[${heading}]`);
        for (const it of items) sections.push(renderer(it));
        sections.push('');
    };

    pushSection('MAIN CHARACTERS', chars.main, renderCharLine);
    pushSection('SUPPORTING', chars.supporting, renderCharLine);
    if (chars.minor.length) pushSection('MINOR / BACKGROUND', chars.minor, renderCharLine);

    pushSection('LOCATIONS', types.location, renderEntityLine);
    pushSection('FACTIONS', types.faction, renderEntityLine);
    pushSection('CULTURES / RACES', types.culture, renderEntityLine);
    pushSection('LANGUAGES', types.language, renderEntityLine);
    pushSection('ITEMS', types.item, renderEntityLine);
    pushSection('ABILITIES', types.ability, renderEntityLine);
    pushSection('RANKS / TITLES', types.rank_title, renderEntityLine);

    // Quests — split active vs dormant by disable flag.
    const activeQuests = types.quest.filter(q => !q.disabled);
    const dormantQuests = types.quest.filter(q => q.disabled);
    pushSection('QUESTS — ACTIVE', activeQuests, renderEntityLine);
    if (dormantQuests.length) pushSection('QUESTS — DORMANT', dormantQuests, renderEntityLine);

    pushSection('EVENTS / HISTORY', types.event, renderEntityLine);
    pushSection('DOCUMENTS', types.document, renderEntityLine);
    pushSection('RECURRING SCENES', types.scene, renderEntityLine);
    pushSection('RULES / WORLD FACTS', types.rule, renderEntityLine);
    pushSection('CONCEPTS', types.concept, renderEntityLine);

    if (sections.length === 0) return ''; // nothing to roster

    const header = '## ACTIVE WORLD ROSTER (Card to Lorebook auto-generated — always loaded for AI awareness)';
    const footer = '(Specific details for each entity load via their own keys when mentioned. ↔ marks cross-references.)';

    let text = [header, '', ...sections, footer].join('\n').replace(/\n{3,}/g, '\n\n');

    // Budget enforcement — if over cap, drop minor characters first, then
    // dormant quests, then concepts, then events, etc. Repeat until fits.
    const dropOrder = [
        () => chars.minor.splice(0),
        () => dormantQuests.splice(0),
        () => types.concept.splice(0),
        () => types.scene.splice(0),
        () => types.event.splice(0),
        () => types.document.splice(0),
        () => types.language.splice(0),
        () => types.culture.splice(0),
        () => types.rank_title.splice(0),
        () => types.ability.splice(0),
    ];
    let i = 0;
    while (text.length > ROSTER_CHAR_BUDGET && i < dropOrder.length) {
        dropOrder[i++]();
        // re-render
        const reRendered = [header, ''];
        const reSections = [];
        const re = (heading, items, renderer) => {
            if (!items.length) return;
            reSections.push(`[${heading}]`);
            for (const it of items) reSections.push(renderer(it));
            reSections.push('');
        };
        re('MAIN CHARACTERS', chars.main, renderCharLine);
        re('SUPPORTING', chars.supporting, renderCharLine);
        re('MINOR / BACKGROUND', chars.minor, renderCharLine);
        re('LOCATIONS', types.location, renderEntityLine);
        re('FACTIONS', types.faction, renderEntityLine);
        re('CULTURES / RACES', types.culture, renderEntityLine);
        re('LANGUAGES', types.language, renderEntityLine);
        re('ITEMS', types.item, renderEntityLine);
        re('ABILITIES', types.ability, renderEntityLine);
        re('RANKS / TITLES', types.rank_title, renderEntityLine);
        re('QUESTS — ACTIVE', activeQuests, renderEntityLine);
        re('QUESTS — DORMANT', dormantQuests, renderEntityLine);
        re('EVENTS / HISTORY', types.event, renderEntityLine);
        re('DOCUMENTS', types.document, renderEntityLine);
        re('RECURRING SCENES', types.scene, renderEntityLine);
        re('RULES / WORLD FACTS', types.rule, renderEntityLine);
        re('CONCEPTS', types.concept, renderEntityLine);
        text = [...reRendered, ...reSections, footer].join('\n').replace(/\n{3,}/g, '\n\n');
    }

    return text;
}

/**
 * Truncate first sentence of content for use as a 1-line tag.
 */
function oneLineTag(content, maxChars = 50) {
    const s = String(content || '').replace(/^##.*$/gm, '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const sentEnd = s.search(/[.!?]\s/);
    const cut = sentEnd > 0 ? s.slice(0, sentEnd) : s;
    if (cut.length <= maxChars) return cut;
    return cut.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
}

/**
 * Rebuild the roster entry for a given lorebook. Upserts the
 * [card2lore:roster] World Roster entry with constant=true so it always
 * loads, giving the AI awareness of what exists in the book without firing
 * every individual entry.
 *
 * @returns {Promise<{ wrote: boolean, entryCount: number, target: string }>}
 */
export async function rebuildRoster(worldName) {
    if (!worldName) return { wrote: false, entryCount: 0, target: '' };
    const data = await loadOrInit(worldName);
    const content = buildRosterText(data);
    if (!content) {
        // No card2lore entries — remove roster if it exists.
        const existing = findCollidingEntry(data, makeRosterStamp());
        if (existing) {
            delete data.entries[existing.uid];
            await saveWorldInfo(worldName, data, true);
            await updateWorldInfoList();
        }
        return { wrote: false, entryCount: 0, target: worldName };
    }

    const stamp = makeRosterStamp();
    const existing = findCollidingEntry(data, stamp);
    const rosterEntryData = {
        keys: ['roster', 'world roster', 'lorebook contents'],
        secondaryKeys: [],
        content,
        comment: stamp,
        constant: true,
        selective: false,
        order: 50, // very high — fires before any specific entry
        position: 0,
        probability: 100,
        useProbability: false,
        selectiveLogic: 0,
        depth: 4,
        // The roster MUST survive token budget trimming; without it the AI
        // loses awareness of the world.
        ignoreBudget: true,
        // excludeRecursion: nothing else can trigger the roster (it's already
        //   constant=true so it always fires anyway — belt-and-braces).
        // preventRecursion: when the roster fires, its content does NOT
        //   trigger cascading activation of every entry whose key matches a
        //   name in the roster. Without this flag, an always-on roster that
        //   lists every entity name would fire every entry every turn,
        //   destroying token budget and the point of selective routing.
        excludeRecursion: true,
        preventRecursion: true,
    };

    if (existing) {
        const old = data.entries[existing.uid];
        old.key = [...rosterEntryData.keys];
        old.keysecondary = [];
        old.content = rosterEntryData.content;
        old.constant = true;
        old.selective = false;
        old.order = 50;
        old.position = 0;
        old.probability = 100;
        old.useProbability = false;
        // Force the recursion flags on rebuild — rosters created by earlier
        // betas lacked preventRecursion and were cascade-triggering every
        // matched entry every turn. Always re-apply on rebuild.
        old.excludeRecursion = true;
        old.preventRecursion = true;
    } else {
        addEntryToData(data, rosterEntryData);
    }
    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    // Count how many entries the roster covers for the return value.
    const entryCount = Object.values(data.entries)
        .filter(e => String(e?.comment || '').startsWith('[card2lore:') && !String(e?.comment || '').startsWith(`[${ENTRY_STAMP_ROSTER}]`))
        .length;
    log(`rebuildRoster(${worldName}) wrote roster covering ${entryCount} entries`);
    return { wrote: true, entryCount, target: worldName };
}

/* ============================================================
 * Phase I — Base-world context loader for adaptive migration
 * ============================================================ */

/**
 * Load a lorebook and extract its World Roster entry + all constant=true
 * entries + entries whose keys match any token from the cardText.
 *
 * Returns null if the book doesn't exist.
 *
 * @param {string} worldName
 * @param {string} cardText  the card prompt text — used to keyword-match relevant entries
 * @param {object} [opts]  { maxRelevantEntries?: 8, maxConstantEntries?: 6 }
 */
export async function loadBaseLorebookContext(worldName, cardText, opts = {}) {
    const maxRelevant = opts.maxRelevantEntries ?? 8;
    const maxConst    = opts.maxConstantEntries ?? 6;
    if (!worldName) return null;
    if (!world_names?.includes(worldName)) return null;
    const data = await loadOrInit(worldName);
    if (!data?.entries) return null;

    let roster = '';
    const constantEntries = [];
    const allEntries = [];

    for (const entry of Object.values(data.entries)) {
        const comment = String(entry?.comment || '').trim();
        if (comment.startsWith(`[${ENTRY_STAMP_ROSTER}]`)) {
            roster = String(entry.content || '');
            continue;
        }
        if (entry.disable) continue;
        const name = comment.replace(/^\[card2lore:[^\]]+\]\s*/i, '').split(' — ')[0].trim() || (entry.key?.[0] ?? 'Entry');
        if (entry.constant && constantEntries.length < maxConst) {
            constantEntries.push({ name, content: String(entry.content || '').slice(0, 400) });
        }
        allEntries.push({ name, content: String(entry.content || '').slice(0, 400), keys: entry.key || [] });
    }

    // Keyword match: find entries whose keys appear in the card text.
    const cardLower = String(cardText || '').toLowerCase();
    const matches = [];
    for (const e of allEntries) {
        if (constantEntries.some(c => c.name === e.name)) continue;
        const hit = e.keys.some(k => {
            const kk = String(k || '').toLowerCase();
            return kk.length >= 3 && cardLower.includes(kk);
        });
        if (hit) matches.push(e);
        if (matches.length >= maxRelevant) break;
    }

    return {
        worldName,
        roster,
        constantEntries,
        relevantEntries: matches,
    };
}

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
