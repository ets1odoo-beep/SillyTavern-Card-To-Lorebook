/**
 * Conversion engine — runs the AI call that converts one card's prompt text
 * into a structured lorebook entry. Handles connection-profile switching,
 * robust JSON parse, retries, and per-call abort.
 */

import { generateQuietPrompt } from '/script.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';

import { buildCardPromptText, detectImportance } from './cardExtractor.js';
import { robustJsonParse, sanitizeContent, trimWords, log, warn } from './core.js';
import { sanitizeKeyList, sanitizeSecondaryAgainstPrimary } from './keyHygiene.js';

/* ============================================================
 * AI connection profile (same pattern as the persona generator)
 * ============================================================ */

export function listAiConnectionProfiles() {
    try {
        return SillyTavern?.getContext?.()?.extensionSettings?.connectionManager?.profiles || [];
    } catch {
        return [];
    }
}

function getAiProfileName(profileIdOrName) {
    const raw = String(profileIdOrName ?? '').trim();
    if (!raw) return '';
    const profile = listAiConnectionProfiles().find(p => p?.id === raw || p?.name === raw);
    return String(profile?.name ?? raw);
}

async function getCurrentAiProfileName() {
    try {
        const cmd = SlashCommandParser.commands['profile'];
        if (!cmd) return '';
        const result = await cmd.callback({}, '');
        return (typeof result === 'string' ? result : '').trim();
    } catch {
        return '';
    }
}

async function switchAiProfile(name) {
    const target = String(name || '').trim();
    if (!target) return;
    try {
        const cmd = SlashCommandParser.commands['profile'];
        if (cmd) await cmd.callback({}, target);
    } catch (e) {
        warn('Failed to switch AI connection profile', e);
    }
}

/* ============================================================
 * Prompt assembly
 * ============================================================ */

function buildPrompt(profile, cardText, importanceHint) {
    const baseInstruction = String(profile?.baseInstruction || '').trim();
    const hint = importanceHint
        ? `\n\nIMPORTANCE HINT (auto-detected from card text): "${importanceHint}". You may override if the card text clearly suggests a different tier.`
        : '';
    return [
        baseInstruction + hint,
        '',
        '=== CARD CONTENT ===',
        cardText,
        '=== END CARD CONTENT ===',
    ].join('\n');
}

/* ============================================================
 * JSON schema hints for structured-output-capable models
 * ============================================================ */

const FLAT_JSON_SCHEMA = {
    type: 'object',
    properties: {
        name: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
        content: { type: 'string' },
    },
    required: ['name', 'content'],
};

const MODULAR_JSON_SCHEMA = {
    type: 'object',
    properties: {
        name: { type: 'string' },
        importance: { type: 'string', enum: ['main', 'supporting', 'minor'] },
        entries: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    section: { type: 'string' },
                    keys: { type: 'array', items: { type: 'string' } },
                    secondaryKeys: { type: 'array', items: { type: 'string' } },
                    constant: { type: 'boolean' },
                    order: { type: 'number' },
                    probability: { type: 'number' },
                    content: { type: 'string' },
                },
                required: ['section', 'content'],
            },
        },
    },
    required: ['name', 'entries'],
};

// selectiveLogic values mirror ST's world-info AND_ANY (0) / NOT_ALL (1) /
// NOT_ANY (2) / AND_ALL (3) constants. AND_ALL means primary key must match
// AND every secondary key must also match — used for relationships so the
// entry only fires when both this char AND the linked entity are present.
export const SELECTIVE_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

// Section → default config. Anchor uses card name as PRIMARY key; everything
// else uses cue words as primary and card name as SECONDARY (AND-gated).
// constant: true only for anchor of main importance (always-on identity glue).
export const SECTION_DEFAULTS = {
    anchor:        { order: 100, probability: 100, constantFor: ['main'], wordCap: 80,  selectiveLogic: SELECTIVE_LOGIC.AND_ANY,  nameAsPrimary: true  },
    appearance:    { order: 300, probability: 100, constantFor: [],       wordCap: 350, selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false },
    personality:   { order: 200, probability: 100, constantFor: [],       wordCap: 250, selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false },
    voice:         { order: 200, probability: 100, constantFor: [],       wordCap: 200, selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false },
    background:    { order: 400, probability: 90,  constantFor: [],       wordCap: 300, selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false },
    relationships: { order: 400, probability: 100, constantFor: [],       wordCap: 200, selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false },
    quirks:        { order: 350, probability: 100, constantFor: [],       wordCap: 200, selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false },
};

/**
 * Resolve section config — built-in defaults can be overridden per-profile via
 * profile.sectionOverrides[section] = { order?, probability?, constant?,
 * wordCap?, selectiveLogic? }. Custom sections (not in SECTION_DEFAULTS) fall
 * back to background defaults unless the profile defines them explicitly.
 *
 * @param {string} section
 * @param {string} importance  main|supporting|minor
 * @param {object} [profile]   conversion profile for sectionOverrides
 */
export function sectionDefaultsFor(section, importance, profile = null) {
    const key = String(section || '').toLowerCase();
    const builtin = SECTION_DEFAULTS[key] || SECTION_DEFAULTS.background;
    const override = profile?.sectionOverrides?.[key] || {};

    const baseConstant = builtin.constantFor.includes(String(importance || '').toLowerCase());

    return {
        order:          Number.isFinite(override.order)          ? override.order          : builtin.order,
        probability:    Number.isFinite(override.probability)    ? override.probability    : builtin.probability,
        constant:       typeof override.constant === 'boolean'   ? override.constant       : baseConstant,
        wordCap:        Number.isFinite(override.wordCap)        ? override.wordCap        : builtin.wordCap,
        selectiveLogic: Number.isFinite(override.selectiveLogic) ? override.selectiveLogic : builtin.selectiveLogic,
        nameAsPrimary:  typeof override.nameAsPrimary === 'boolean' ? override.nameAsPrimary : builtin.nameAsPrimary,
    };
}

/**
 * Reduce-friendly check for whether a section uses card name as primary
 * (i.e. anchor) or as a secondary AND-gate (everything else).
 */
function isAnchorSection(section) {
    return String(section || '').toLowerCase() === 'anchor';
}

/* ============================================================
 * Per-card conversion
 * ============================================================ */

/**
 * Convert ONE card into an array of internal entries using the AI.
 * Returns one entry in flat mode, multiple sub-entries in modular mode.
 *
 * @param {object} card        ST character object
 * @param {object} profile     conversion profile
 * @param {AbortSignal} [signal]  for cancelling the queue
 * @returns {Promise<object[]>} array of internal entry shapes
 */
export async function convertOneCard(card, profile, signal) {
    if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');

    const cardText = buildCardPromptText(card, profile);
    if (!cardText) throw new Error('No extractable content for card');

    const importanceHint = detectImportance(card);
    const prompt = buildPrompt(profile, cardText, importanceHint);
    const modular = profile.entrySplitMode === 'modular';
    const schema = profile.outputFormat === 'json'
        ? (modular ? MODULAR_JSON_SCHEMA : FLAT_JSON_SCHEMA)
        : null;

    // Switch connection profile if the profile binds one. Restore after.
    const targetProfileName = getAiProfileName(profile.aiConnectionProfile);
    let previousProfile = '';
    if (targetProfileName) {
        previousProfile = await getCurrentAiProfileName();
        if (previousProfile && previousProfile !== targetProfileName) {
            await switchAiProfile(targetProfileName);
        } else {
            previousProfile = '';
        }
    }

    let reply = '';
    try {
        if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');
        reply = await generateQuietPrompt({
            quietPrompt: prompt,
            responseLength: Number(profile.responseLength) || (modular ? 3500 : 1500),
            jsonSchema: schema,
            trimToSentence: false,
        });
    } finally {
        if (previousProfile) {
            await switchAiProfile(previousProfile);
        }
    }

    if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');

    // Parse + dispatch on mode.
    let parsed;
    try {
        parsed = robustJsonParse(reply).data;
    } catch (e) {
        warn('JSON parse failed for', card.name, '— falling back to flat text mode');
        return [textFallbackEntry(card, reply, profile)];
    }

    if (modular) {
        return parsedToModularEntries(card, parsed, profile);
    }
    return [parsedToEntry(card, parsed, profile)];
}

function parsedToEntry(card, parsed, profile) {
    const name = String(parsed?.name || card?.name || 'Unknown').trim();
    const keys = sanitizeKeyList(
        Array.isArray(parsed?.keys) ? parsed.keys : [name],
        { alwaysInclude: [name], maxKeys: 8 },
    );

    let content = sanitizeContent(String(parsed?.content || ''));
    if (Number.isFinite(profile.wordCap)) content = trimWords(content, profile.wordCap);

    return {
        keys,
        secondaryKeys: [],
        content,
        comment: '', // populated by caller (uses makeCardStamp with profile name)
        constant: false,
        selective: true,
        order: 100,
        position: 0,
        probability: 100,
        useProbability: false,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        _origin: {
            source: 'card',
            cardName: card?.name || name,
            profileId: profile.id,
            profileName: profile.name,
            createdAt: new Date().toISOString(),
        },
    };
}

/**
 * Modular parser — takes the AI's multi-entry JSON and returns an array of
 * fully-configured internal entries (one per section the AI returned).
 *
 * Each sub-entry has properly-tiered: keys, secondaryKeys, constant, order,
 * probability, content, and a stamped comment like "[card2lore:Anchor] Arika".
 */
function parsedToModularEntries(card, parsed, profile) {
    const cardName = String(parsed?.name || card?.name || 'Unknown').trim();
    const importance = String(parsed?.importance || 'supporting').toLowerCase();
    const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];

    if (rawEntries.length === 0) {
        warn('Modular response had no entries — falling back to one-entry parse');
        return [parsedToEntry(card, { name: cardName, keys: [cardName], content: parsed?.content || '' }, profile)];
    }

    // Collect every name-form for this card (canonical + AI-supplied nicknames
    // in the anchor entry). Used as the "always include" gate for anchor
    // primary keys, and as the secondary AND-gate for every other section.
    const nameForms = new Set([cardName.toLowerCase()]);
    const anchorRaw = rawEntries.find(e => String(e?.section || '').toLowerCase() === 'anchor');
    if (anchorRaw && Array.isArray(anchorRaw.keys)) {
        for (const k of anchorRaw.keys) {
            const v = String(k || '').trim();
            if (v) nameForms.add(v.toLowerCase());
        }
    }
    const nameKeyList = [...nameForms].map(s => {
        // restore capitalisation of the canonical card name
        if (s === cardName.toLowerCase()) return cardName;
        return s.replace(/\b\w/g, c => c.toUpperCase());
    });

    const out = [];
    for (const raw of rawEntries) {
        const section = String(raw?.section || 'misc').toLowerCase();
        const def = sectionDefaultsFor(section, importance, profile);

        let keys;
        let secondaryKeys;

        if (def.nameAsPrimary) {
            // Anchor: card name forms are the primary trigger. AI's `keys`
            // (nicknames/aliases) are merged into primary too.
            keys = sanitizeKeyList(
                [...(Array.isArray(raw?.keys) ? raw.keys : []), ...nameKeyList],
                { alwaysInclude: [cardName], maxKeys: 8 },
            );
            secondaryKeys = sanitizeSecondaryAgainstPrimary(
                keys,
                Array.isArray(raw?.secondaryKeys) ? raw.secondaryKeys : [],
                4,
            );
        } else {
            // Non-anchor: AI's `keys` are section-specific cue words → primary.
            // Card name + nicknames go into secondaryKeys (AND-gated via
            // selectiveLogic = AND_ALL below).
            keys = sanitizeKeyList(
                Array.isArray(raw?.keys) ? raw.keys : [],
                { maxKeys: 8 },
            );
            // AI may have also dropped name into secondaryKeys — merge with
            // our authoritative name forms.
            const merged = [
                ...nameKeyList,
                ...(Array.isArray(raw?.secondaryKeys) ? raw.secondaryKeys : []),
            ];
            secondaryKeys = sanitizeSecondaryAgainstPrimary(keys, merged, 6);
            // Safety: if AI gave us zero meaningful primary keys, fall back to
            // anchor-style triggering so the entry isn't dead weight.
            if (keys.length === 0) {
                keys = nameKeyList.slice(0, 4);
                secondaryKeys = [];
            }
        }

        // Constant: AI override > defaults-by-importance.
        const constant = typeof raw?.constant === 'boolean' ? raw.constant : def.constant;
        const order = Number.isFinite(raw?.order) ? raw.order : def.order;
        const probability = Number.isFinite(raw?.probability) ? raw.probability : def.probability;
        const selectiveLogic = Number.isFinite(raw?.selectiveLogic) ? raw.selectiveLogic : def.selectiveLogic;

        let content = sanitizeContent(String(raw?.content || ''));
        if (Number.isFinite(def.wordCap)) content = trimWords(content, def.wordCap);
        if (!content) continue;

        // Capitalised section label for the comment stamp.
        const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);

        out.push({
            keys,
            secondaryKeys,
            content,
            // Comment populated by caller (uses makeCardStamp with section)
            comment: '',
            constant,
            // Non-constant entries use selective key matching by default
            selective: !constant,
            order,
            position: 0,
            probability,
            useProbability: probability < 100,
            selectiveLogic,
            // Section-driven defaults that ST's createWorldInfoEntry will pick up
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            _origin: {
                source: 'card',
                section,
                sectionLabel,
                importance,
                cardName,
                profileId: profile.id,
                profileName: profile.name,
                createdAt: new Date().toISOString(),
            },
        });
    }

    return out;
}

function textFallbackEntry(card, rawText, profile) {
    const name = card?.name || 'Unknown';
    let content = sanitizeContent(String(rawText || ''));
    if (Number.isFinite(profile.wordCap)) content = trimWords(content, profile.wordCap);
    return {
        keys: sanitizeKeyList([name], { alwaysInclude: [name], maxKeys: 4 }),
        secondaryKeys: [],
        content,
        comment: '',
        constant: false,
        selective: true,
        order: 100,
        position: 0,
        probability: 100,
        useProbability: false,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        _origin: {
            source: 'card-fallback',
            cardName: name,
            profileId: profile.id,
            profileName: profile.name,
            createdAt: new Date().toISOString(),
        },
    };
}
