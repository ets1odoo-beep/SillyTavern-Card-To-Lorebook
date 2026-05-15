/**
 * Card reading — pulls usable text + embedded character_book from a
 * SillyTavern character object, respecting the profile's per-field toggles.
 */

import { characters } from '/script.js';

import { CARD_FIELDS } from './profiles.js';
import { estimateTokens, log } from './core.js';

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

    blocks.push(block('Card name', card.name));

    for (const f of CARD_FIELDS) {
        if (include[f.key] === false) continue;
        const value =
            f.key === 'tags' ? (card.tags || card.data?.tags || []) :
            f.key === 'alternate_greetings' ? (card.alternate_greetings || card.data?.alternate_greetings || []) :
            card[f.key] ?? card.data?.[f.key];
        const text = fieldToString(value);
        if (!text) continue;
        blocks.push(block(f.label, text));
    }

    return blocks.filter(Boolean).join('\n\n').trim();
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
    return entries.map(e => normaliseEmbeddedEntry(e, card.name));
}

/**
 * Convert a V2 character_book entry into our internal entry shape that
 * lorebookIO knows how to write. We keep the source data verbatim.
 */
function normaliseEmbeddedEntry(raw, cardName) {
    const keys = []
        .concat(Array.isArray(raw.keys) ? raw.keys : [])
        .map(s => String(s || '').trim())
        .filter(Boolean);
    const secondaryKeys = []
        .concat(Array.isArray(raw.secondary_keys) ? raw.secondary_keys : [])
        .map(s => String(s || '').trim())
        .filter(Boolean);
    return {
        // Internal shape — converted by lorebookIO.addEntry()
        keys,
        secondaryKeys,
        content: String(raw.content || '').trim(),
        comment: String(raw.comment || raw.name || keys[0] || `${cardName} entry`),
        constant: !!raw.constant,
        selective: !!raw.selective,
        order: Number.isFinite(raw.insertion_order) ? raw.insertion_order : 100,
        position: Number.isFinite(raw.position) ? raw.position : 0,
        // Origin metadata
        _origin: {
            source: 'embedded',
            cardName,
        },
    };
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
