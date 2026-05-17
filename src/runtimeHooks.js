/**
 * Phase F — runtime intelligence hooks.
 *
 * 1. WORLDINFO_ENTRIES_LOADED listener — at chat-time, mutate entries based
 *    on dynamic state (e.g. disable dormant quest entries until their
 *    automationId is fired by a Quick Reply).
 * 2. automationId helpers — pair quest entries with stable IDs so user
 *    buttons / scripts can mark them active/dormant.
 * 3. Content decorator injection — for entries the AI flagged with
 *    cross-references, prepend `@@activate <other-entry-name>` so anchor
 *    entries cross-trigger related sections without keys needing to overlap.
 */

import { eventSource } from '/script.js';

import { log } from './core.js';

const C2L_AUTOMATION_PREFIX = 'card2lore.';

/**
 * Build a stable automationId for an entity: prefix + lowercased name.
 * Quick Replies can target this id with /world-activate.
 */
export function makeAutomationId(entityType, entityName) {
    const t = String(entityType || 'entry').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const n = String(entityName || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return `${C2L_AUTOMATION_PREFIX}${t}.${n}`;
}

/**
 * Inject content decorators (@@activate / @@dont_activate) into an entry's
 * content based on its _origin.linkedTo cross-references. Cross-references
 * are mapped to entry names; the WI engine treats `@@activate <name>` as a
 * force-trigger on that named entry.
 *
 * @param {object} entry  internal entry shape
 * @returns {string}      content with decorator lines prepended
 */
export function decorateContent(entry) {
    const linkedTo = entry?._origin?.linkedTo || [];
    if (!Array.isArray(linkedTo) || linkedTo.length === 0) return entry.content;
    const decorators = linkedTo
        .map(name => `@@activate ${String(name).trim()}`)
        .filter(Boolean)
        .join('\n');
    if (!decorators) return entry.content;
    return `${decorators}\n${entry.content}`;
}

/**
 * Install the WORLDINFO_ENTRIES_LOADED listener. Inspects the loaded entries
 * collection at chat-time and applies runtime intelligence:
 *
 *   - Auto-disable dormant quest entries (those with `_c2lOrigin.dormant === true`
 *     or `disable: true`) unless they're force-activated via automationId.
 *   - (Future) prioritise entries linked to the most recently mentioned entities.
 *
 * Currently this is a low-cost pass that just logs the entry breakdown so we
 * can verify the loader is firing.
 */
export function installRuntimeHooks() {
    try {
        eventSource.on('worldinfo_entries_loaded', (lore) => {
            // lore = { globalLore, characterLore, chatLore, personaLore } (each an array of entries)
            if (!lore || typeof lore !== 'object') return;
            try {
                const buckets = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
                let total = 0;
                let mine = 0;
                for (const k of buckets) {
                    const arr = lore[k];
                    if (!Array.isArray(arr)) continue;
                    total += arr.length;
                    for (const e of arr) {
                        const c = String(e?.comment || '');
                        if (c.startsWith('[card2lore:')) mine++;
                    }
                }
                if (mine > 0) log(`worldinfo_entries_loaded: ${mine}/${total} entries are card2lore-stamped`);
            } catch (e) { /* swallow */ }
        });
        log('runtime hooks installed (worldinfo_entries_loaded listener)');
    } catch (e) {
        console.warn('[Card2Lore] runtime hooks install failed', e);
    }
}
