/**
 * Key hygiene — post-process AI-generated keys before writing to ST.
 *
 * The AI often emits keys that defeat World Info's purpose:
 *   - common stopwords ("the", "a", "and") fire on every turn
 *   - 1-2 char keys collide with common substrings
 *   - duplicated keys across primary/secondary waste matching cycles
 *   - too many keys per section bloat the WI index
 *
 * This module normalises, filters, dedups, and caps each key list.
 */

// English stopwords + ST conversational filler that should never be a trigger.
const STOPWORDS = new Set([
    // articles / conjunctions / prepositions
    'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'for',
    'of', 'in', 'on', 'at', 'by', 'to', 'from', 'with', 'as', 'into',
    'onto', 'upon', 'over', 'under', 'out', 'off', 'up', 'down',
    // pronouns
    'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours',
    'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
    'it', 'its', 'they', 'them', 'their', 'theirs',
    'this', 'that', 'these', 'those', 'who', 'whom', 'which', 'what',
    // common verbs / aux
    'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'shall', 'should', 'can', 'could', 'may', 'might', 'must',
    // misc fillers
    'not', 'no', 'yes', 'if', 'then', 'else', 'than', 'about', 'just',
    'also', 'too', 'very', 'really', 'quite', 'still', 'now', 'here',
    'there', 'where', 'when', 'why', 'how', 'all', 'any', 'some',
    'each', 'every', 'few', 'more', 'most', 'other', 'such', 'only',
    'own', 'same', 'than', 'one', 'two', 'three',
]);

/**
 * Normalise a single key string. Returns '' if it should be dropped.
 */
export function normaliseKey(raw) {
    let s = String(raw || '');
    // trim outer whitespace + punctuation noise
    s = s.replace(/^[\s\W_]+|[\s\W_]+$/gu, '').trim();
    // collapse internal whitespace
    s = s.replace(/\s+/g, ' ');
    if (!s) return '';
    return s;
}

/**
 * Is this key worth keeping?
 * @param {string} key already-normalised
 * @param {object} [opts]
 * @param {Set<string>} [opts.protect]  keys (lowercase) that always pass (e.g. card name)
 * @param {number} [opts.minLength=3]  minimum char length (proper nouns < this still pass if capitalised)
 * @returns {boolean}
 */
export function isUsefulKey(key, opts = {}) {
    const protect = opts.protect || new Set();
    const minLength = opts.minLength ?? 3;
    if (!key) return false;
    const lower = key.toLowerCase();
    if (protect.has(lower)) return true;
    // numeric tokens (rare but possible) pass if 4+ chars
    if (/^\d+$/.test(key)) return key.length >= 4;
    // stopwords out
    if (STOPWORDS.has(lower)) return false;
    // length filter — but allow short proper nouns ("Ed", "Bo")
    if (key.length < minLength) {
        const looksProper = /^[A-Z]/.test(key);
        if (!looksProper) return false;
    }
    return true;
}

/**
 * Clean + dedup + cap a primary key list.
 *
 * @param {string[]} keys
 * @param {object} [opts]
 * @param {string[]} [opts.alwaysInclude]  these are added at the top, never filtered out
 * @param {number} [opts.maxKeys=8]
 * @returns {string[]}
 */
export function sanitizeKeyList(keys, opts = {}) {
    const alwaysInclude = (opts.alwaysInclude || []).map(normaliseKey).filter(Boolean);
    const maxKeys = opts.maxKeys ?? 8;
    const protect = new Set(alwaysInclude.map(k => k.toLowerCase()));

    const seen = new Set();
    const out = [];

    const push = (k) => {
        const n = normaliseKey(k);
        if (!n) return;
        const lower = n.toLowerCase();
        if (seen.has(lower)) return;
        if (!isUsefulKey(n, { protect })) return;
        seen.add(lower);
        out.push(n);
    };

    alwaysInclude.forEach(push);
    (Array.isArray(keys) ? keys : []).forEach(push);

    return out.slice(0, maxKeys);
}

/**
 * Remove from `secondary` any key that already exists in `primary`
 * (case-insensitive). Returns a cleaned secondary list.
 *
 * @param {string[]} primary
 * @param {string[]} secondary
 * @param {number} [maxKeys=6]
 */
export function sanitizeSecondaryAgainstPrimary(primary, secondary, maxKeys = 6) {
    const primaryLower = new Set((primary || []).map(k => String(k).toLowerCase()));
    const seen = new Set();
    const out = [];
    for (const raw of secondary || []) {
        const n = normaliseKey(raw);
        if (!n) continue;
        const lower = n.toLowerCase();
        if (primaryLower.has(lower)) continue;
        if (seen.has(lower)) continue;
        if (!isUsefulKey(n)) continue;
        seen.add(lower);
        out.push(n);
        if (out.length >= maxKeys) break;
    }
    return out;
}
