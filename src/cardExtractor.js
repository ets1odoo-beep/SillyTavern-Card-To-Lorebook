/**
 * Card reading — pulls usable text + embedded character_book from a
 * SillyTavern character object, respecting the profile's per-field toggles.
 */

import { characters, getOneCharacter, getRequestHeaders } from '/script.js';

import { CARD_FIELDS } from './profiles.js';
import { estimateTokens, sanitizeContent, log } from './core.js';
import { sanitizeKeyList } from './keyHygiene.js';

// Hard cap on embedded book entry content — some embedded entries are huge
// and don't deserve full inclusion. ~4000 chars ≈ 1000 tokens.
const EMBEDDED_CONTENT_CHAR_CAP = 4000;
const FULL_FIELD_PROFILE = {
    includeFields: Object.fromEntries(CARD_FIELDS.map(f => [f.key, true])),
};

/**
 * Get the character object for a given ST character index (the IDs in
 * BulkEditOverlay.selectedCharacters).
 */
export function getCardByIndex(idx) {
    const i = Number(idx);
    if (!Number.isFinite(i)) return null;
    return characters[i] ?? null;
}

/**
 * Bulk character lists may contain shallow objects with only name/tags/avatar.
 * Load the full card from SillyTavern before conversion if the current object
 * has no substantive prompt fields.
 */
export async function ensureFullCard(card, profile) {
    if (!card?.avatar || hasExtractableContent(card, profile)) return card;
    try {
        await getOneCharacter(card.avatar);
        const loaded = characters.find(c => c?.avatar === card.avatar);
        if (hasExtractableContent(loaded, profile) || hasExtractableContent(loaded, FULL_FIELD_PROFILE)) return loaded;

        const response = await fetch('/api/characters/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: card.avatar }),
        });
        if (response.ok) {
            const fetched = await response.json();
            if (fetched && typeof fetched === 'object') {
                fetched.avatar = fetched.avatar || card.avatar;
                if (hasExtractableContent(fetched, profile) || hasExtractableContent(fetched, FULL_FIELD_PROFILE)) return fetched;
            }
        }
        const fromPng = await fetchCardFromPng(card.avatar);
        if (hasExtractableContent(fromPng, profile) || hasExtractableContent(fromPng, FULL_FIELD_PROFILE)) return fromPng;

        return loaded || card;
    } catch (e) {
        console.warn('[Card2Lore] Failed to load full character card for', card?.name || card?.avatar, e);
        return card;
    }
}

async function fetchCardFromPng(avatar) {
    if (!avatar) return null;
    const response = await fetch(`/characters/${encodeURIComponent(avatar)}`, { cache: 'reload' });
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    const chunks = extractPngTextChunks(new Uint8Array(buffer));
    const encoded = chunks.ccv3 || chunks.chara;
    if (!encoded) return null;

    const json = JSON.parse(decodeBase64Utf8(encoded));
    const data = json?.data && typeof json.data === 'object' ? json.data : {};
    return {
        ...json,
        ...data,
        data,
        name: data.name || json.name,
        avatar,
    };
}

function extractPngTextChunks(bytes) {
    const out = {};
    const decoder = new TextDecoder('utf-8');
    let offset = 8; // PNG signature
    while (offset + 12 <= bytes.length) {
        const len = readUint32BE(bytes, offset);
        const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
        const start = offset + 8;
        const end = start + len;
        if (end > bytes.length) break;

        if (type === 'tEXt') {
            const data = bytes.slice(start, end);
            const zero = data.indexOf(0);
            if (zero >= 0) {
                const key = decoder.decode(data.slice(0, zero));
                const value = decoder.decode(data.slice(zero + 1));
                out[key] = value;
            }
        }

        offset = end + 4; // CRC
    }
    return out;
}

function readUint32BE(bytes, offset) {
    return ((bytes[offset] << 24) >>> 0)
        + (bytes[offset + 1] << 16)
        + (bytes[offset + 2] << 8)
        + bytes[offset + 3];
}

function decodeBase64Utf8(encoded) {
    const binary = atob(String(encoded || '').trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Normalise a field's raw value into a plain string suitable for the AI
 * prompt. Arrays joined by newlines, missing fields → empty.
 */
function fieldToString(value) {
    if (Array.isArray(value)) {
        return value.map(v => String(v ?? '').trim()).filter(Boolean).join('\n\n');
    }
    return String(value ?? '').trim();
}

/**
 * Compose a single labelled block ("## Description\n…\n").
 */
function block(label, body) {
    const trimmed = fieldToString(body);
    return trimmed ? `## ${label}\n${trimmed}` : '';
}

/**
 * Build the prompt-friendly card text using the profile's includeFields
 * toggles. Returns an empty string if no toggle had any content — caller
 * uses this to detect "no extractable content".
 */
export function buildCardPromptText(card, profile) {
    if (!card || typeof card !== 'object') return '';
    const include = profile?.includeFields ?? {};
    const blocks = [];
    const diag = []; // per-field diagnostic for short-output warning

    blocks.push(block('Card name', card.name || card.data?.name));

    for (const f of CARD_FIELDS) {
        if (include[f.key] === false) { diag.push(`${f.key}=OFF`); continue; }
        // V2 cards store fields at card.data.*; legacy V1 keeps top-level
        // mirrors that may be EMPTY STRINGS (not undefined). The previous
        // `??` fallback skipped the V2 path on empty strings → only Tags
        // got through for chub V2 cards. Compare both and pick the
        // longer / non-empty value.
        let topRaw = card[f.key];
        let v2Raw  = card.data?.[f.key];
        const top = fieldToString(topRaw);
        const v2  = fieldToString(v2Raw);
        let text = v2.length >= top.length ? v2 : top;
        // Tags and alternate_greetings are arrays; serialise consistently.
        if (f.key === 'tags') {
            const tagsTop = Array.isArray(card.tags) ? card.tags : [];
            const tagsV2  = Array.isArray(card.data?.tags) ? card.data.tags : [];
            const tags = tagsV2.length >= tagsTop.length ? tagsV2 : tagsTop;
            text = fieldToString(tags);
        } else if (f.key === 'alternate_greetings') {
            const altTop = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
            const altV2  = Array.isArray(card.data?.alternate_greetings) ? card.data.alternate_greetings : [];
            const alts = altV2.length >= altTop.length ? altV2 : altTop;
            text = fieldToString(alts);
        }
        diag.push(`${f.key}=top:${top.length}/v2:${v2.length}/used:${text.length}`);
        if (!text) continue;
        blocks.push(block(f.label, text));
    }

    const out = blocks.filter(Boolean).join('\n\n').trim();

    // Diagnostic: if the output is suspiciously short (<400 chars after the
    // name + tag boilerplate) something dropped on the floor — log what was
    // available so the user can see the problem in the console. Always log,
    // not gated on debug flag, since this is the #1 cause of "thin output"
    // reports and we want users to be able to file actionable bug reports.
    if (out.length < 400) {
        try {
            // Use console directly so it survives ST log filters.
            console.warn('[Card2Lore] WARNING: card "%s" produced very short prompt text (%d chars). Field diagnostic: %s',
                card?.name || card?.data?.name || '?', out.length, diag.join(' | '));
            console.warn('[Card2Lore] card object shape — top-level keys:', Object.keys(card || {}).join(', '));
            console.warn('[Card2Lore] card.data keys:', Object.keys(card?.data || {}).join(', '));
            // Sample first 200 chars of each candidate description path so user
            // can see if data exists somewhere we're not reading.
            console.warn('[Card2Lore] card.description sample:', String(card?.description || '').slice(0, 200));
            console.warn('[Card2Lore] card.data?.description sample:', String(card?.data?.description || '').slice(0, 200));
        } catch (e) {}
    }

    return out;
}

export function hasSubstantivePromptText(cardText) {
    const text = String(cardText || '').replace(/\r\n/g, '\n');
    const matches = [...text.matchAll(/^##\s+(.+?)\s*\n/gm)];
    if (!matches.length) return text.trim().length > 0;

    for (let i = 0; i < matches.length; i++) {
        const label = String(matches[i][1] || '').trim().toLowerCase();
        const start = matches[i].index + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        const body = text.slice(start, end).trim();
        if (!body) continue;
        if (label === 'card name' || label === 'tags') continue;
        return true;
    }
    return false;
}

/**
 * Pull embedded character_book.entries off the card (V2 spec). Returns an
 * array of plain entry objects (not yet ST-flavoured) — lorebookIO converts
 * them into proper lorebook entries.
 *
 * Embedded book lives at card.data.character_book.entries by spec.
 */
export function getEmbeddedBookEntries(card) {
    const book = card?.data?.character_book;
    if (!book || typeof book !== 'object') return [];
    const entries = Array.isArray(book.entries) ? book.entries : [];
    const out = [];
    const seenSig = new Set();
    for (const raw of entries) {
        const cleaned = normaliseEmbeddedEntry(raw, card.name);
        if (!cleaned) continue; // dropped (empty content, etc)
        // Dedup against itself — embedded books sometimes ship duplicates.
        const sig = `${cleaned.content.slice(0, 80)}::${cleaned.keys.join(',')}`;
        if (seenSig.has(sig)) continue;
        seenSig.add(sig);
        out.push(cleaned);
    }
    return out;
}

/**
 * Convert a V2 character_book entry into our internal entry shape that
 * lorebookIO knows how to write. Applies hygiene:
 *   - sanitises content (strip fences, dangerous HTML, blank-line runs)
 *   - caps content at EMBEDDED_CONTENT_CHAR_CAP chars
 *   - sanitises keys (stopwords, length, cap)
 *   - drops the entry entirely if content is empty after sanitisation
 *   - drops the entry if its only content is the card name verbatim
 *
 * Returns null if the entry should be skipped.
 */
function normaliseEmbeddedEntry(raw, cardName) {
    let content = sanitizeContent(String(raw.content || ''));
    if (!content) return null;
    if (content.length > EMBEDDED_CONTENT_CHAR_CAP) {
        content = content.slice(0, EMBEDDED_CONTENT_CHAR_CAP).trim() + '…';
    }
    // Drop entries that are just the card name verbatim (rare but happens).
    if (content.trim().toLowerCase() === String(cardName || '').toLowerCase()) return null;

    const rawPrimary = Array.isArray(raw.keys) ? raw.keys : [];
    const rawSecondary = Array.isArray(raw.secondary_keys) ? raw.secondary_keys : [];

    const keys = sanitizeKeyList(rawPrimary, { maxKeys: 12 });
    const secondaryKeys = sanitizeKeyList(rawSecondary, { maxKeys: 6 });

    return {
        keys,
        secondaryKeys,
        content,
        comment: String(raw.comment || raw.name || keys[0] || `${cardName} entry`),
        constant: !!raw.constant,
        selective: !!raw.selective,
        order: Number.isFinite(raw.insertion_order) ? raw.insertion_order : 100,
        position: Number.isFinite(raw.position) ? raw.position : 0,
        _origin: {
            source: 'embedded',
            cardName,
        },
    };
}

/**
 * Heuristic importance detection — scans the card text for cues that strongly
 * suggest this is a main / POV / protagonist character vs a side character.
 * Used as a hint surfaced into the AI prompt. AI can still override.
 *
 * Returns: 'main' | 'supporting' | 'minor' | null (if no signal).
 */
export function detectImportance(card) {
    if (!card) return null;
    const text = [
        card.name, card.description, card.personality, card.scenario,
        card.first_mes, card.mes_example, card.creator_notes,
    ].map(v => String(v ?? '')).join('\n').toLowerCase();

    const mainCues = [
        /main\s+character/, /\bprotagonist\b/, /\bpov\b/, /point[ -]of[ -]view/,
        /\{\{user\}\}'s? (?:girlfriend|boyfriend|wife|husband|lover|partner|best friend|childhood friend)/,
        /the player (?:plays|controls)/, /you play as/,
    ];
    const minorCues = [
        /\bminor\b/, /\bbit[- ]?part\b/, /background character/, /mentioned (?:in|only)/,
    ];

    for (const re of mainCues) { if (re.test(text)) return 'main'; }
    for (const re of minorCues) { if (re.test(text)) return 'minor'; }
    return 'supporting';
}

/**
 * Quick pre-flight numbers for cost preview: characters in prompt text + an
 * estimated token cost per card across the selection.
 */
export function preflightStats(cards, profile) {
    let totalPromptChars = 0;
    let totalEmbedded = 0;
    let nonEmpty = 0;
    for (const card of cards) {
        const text = buildCardPromptText(card, profile);
        if (hasSubstantivePromptText(text)) {
            nonEmpty++;
            totalPromptChars += text.length;
        }
        totalEmbedded += getEmbeddedBookEntries(card).length;
    }
    return {
        cards: cards.length,
        nonEmptyCards: nonEmpty,
        estimatedTokensIn: estimateTokens(totalPromptChars),
        estimatedTokensOut: nonEmpty * 800, // rough — 600 word cap ≈ 800 tokens
        estimatedTokensTotal: estimateTokens(totalPromptChars) + nonEmpty * 800,
        embeddedEntries: totalEmbedded,
    };
}

/**
 * True if the card has any field worth feeding to the AI under this profile.
 * Used to decide whether to skip with the "no extractable content" toast.
 */
export function hasExtractableContent(card, profile) {
    const text = buildCardPromptText(card, profile);
    // Name + tags are metadata, not character substance. A tags-only card
    // produces generic placeholder lore, so skip it instead.
    return hasSubstantivePromptText(text);
}
