/**
 * Card reading — pulls usable text + embedded character_book from a
 * SillyTavern character object, respecting the profile's per-field toggles.
 */

import { characters } from '/script.js';

import { CARD_FIELDS } from './profiles.js';
import { estimateTokens, sanitizeContent, log } from './core.js';
import { sanitizeKeyList } from './keyHygiene.js';

// Hard cap on embedded book entry content — some embedded entries are huge
// and don't deserve full inclusion. ~4000 chars ≈ 1000 tokens.
const EMBEDDED_CONTENT_CHAR_CAP = 4000;

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
        if (text) {
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
    // Even just the name isn't enough — need at least one substantive field.
    return text.replace(/^## Card name\n[^\n]*$/m, '').trim().length > 0;
}
