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

// Schema for World Kit modular output: a primary character with sectioned
// entries PLUS otherEntities of mixed types (character/location/item/etc).
// We keep this loose because some models reject overly strict schemas with
// oneOf branches inside arrays — JSON parsing on our end is robust anyway.
const MODULAR_JSON_SCHEMA = {
    type: 'object',
    properties: {
        primaryCharacter: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                importance: { type: 'string', enum: ['main', 'supporting', 'minor'] },
                entries: { type: 'array' },
            },
        },
        otherEntities: { type: 'array' },
        // Legacy shape — still accepted by the parser if AI emits it.
        name: { type: 'string' },
        importance: { type: 'string' },
        entries: { type: 'array' },
    },
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
 * Non-character entity type defaults. Each non-character entity becomes one
 * lorebook entry with these settings unless the AI overrides them.
 */
export const ENTITY_TYPE_DEFAULTS = {
    location: { order: 250, probability: 100, constant: false, wordCap: 250, selectiveLogic: SELECTIVE_LOGIC.AND_ANY },
    item:     { order: 350, probability: 100, constant: false, wordCap: 150, selectiveLogic: SELECTIVE_LOGIC.AND_ANY },
    faction:  { order: 300, probability: 100, constant: false, wordCap: 200, selectiveLogic: SELECTIVE_LOGIC.AND_ANY },
    quest:    { order: 400, probability: 90,  constant: false, wordCap: 200, selectiveLogic: SELECTIVE_LOGIC.AND_ANY },
    concept:  { order: 450, probability: 90,  constant: false, wordCap: 200, selectiveLogic: SELECTIVE_LOGIC.AND_ANY },
};

export function entityDefaultsFor(type) {
    return ENTITY_TYPE_DEFAULTS[String(type || '').toLowerCase()] || ENTITY_TYPE_DEFAULTS.concept;
}

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
 * Top-level modular parser — accepts both:
 *   (a) NEW World Kit shape: { primaryCharacter: {...}, otherEntities: [...] }
 *   (b) OLD modular shape:   { name, importance, entries: [...] }
 *
 * Returns a flat array of internal entries combining primary character
 * sections, every other-character section, and one entry per non-character
 * entity (location, item, faction, quest, concept).
 */
function parsedToModularEntries(card, parsed, profile) {
    // Detect World Kit shape (new) vs legacy modular shape.
    const isWorldKit = parsed && typeof parsed === 'object'
        && (parsed.primaryCharacter || Array.isArray(parsed.otherEntities));

    if (!isWorldKit) {
        // Legacy single-character shape — original behaviour.
        return parseOneCharacter(card, parsed, profile);
    }

    const all = [];

    // Primary character: same as legacy parse, but the AI returns it under
    // .primaryCharacter (which has name/importance/entries).
    if (parsed.primaryCharacter && typeof parsed.primaryCharacter === 'object') {
        const primary = parsed.primaryCharacter;
        // Fall back to the card's actual name if AI omitted it.
        if (!primary.name) primary.name = card?.name;
        const primaryEntries = parseOneCharacter(card, primary, profile);
        all.push(...primaryEntries);
    }

    // Other entities: characters (sectioned) + locations/items/factions/quests/concepts (single-entry).
    const others = Array.isArray(parsed.otherEntities) ? parsed.otherEntities : [];
    for (const ent of others) {
        const type = String(ent?.type || '').toLowerCase();
        if (!ent || !ent.name) continue;
        if (type === 'character') {
            // Treat as a mini-character with its own name + sections.
            const psuedoCard = { name: ent.name }; // synthetic card-name owner
            const sub = parseOneCharacter(psuedoCard, ent, profile);
            // Tag _origin so the preview UI knows this came from otherEntities.
            for (const e of sub) {
                e._origin.fromOtherEntities = true;
                e._origin.parentCardName = card?.name;
            }
            all.push(...sub);
        } else if (ENTITY_TYPE_DEFAULTS[type]) {
            const built = buildNonCharacterEntity(card, ent, type, profile);
            if (built) all.push(built);
        } else {
            // Unknown type — coerce to concept.
            const built = buildNonCharacterEntity(card, ent, 'concept', profile);
            if (built) all.push(built);
        }
    }

    if (all.length === 0) {
        warn('World Kit response produced no entries — falling back to one-entry parse');
        return [parsedToEntry(card, { name: card?.name, keys: [card?.name], content: '' }, profile)];
    }
    return all;
}

/**
 * Parse a single character object {name, importance, entries:[{section,...}]}
 * into internal entries. Used for both primaryCharacter and other-character
 * extractions.
 */
function parseOneCharacter(card, parsed, profile) {
    const cardName = String(parsed?.name || card?.name || 'Unknown').trim();
    const importance = String(parsed?.importance || 'supporting').toLowerCase();
    const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];

    if (rawEntries.length === 0) {
        warn(`Character "${cardName}" had no entries — falling back to one-entry parse`);
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

/**
 * Build a single internal entry for a non-character world entity
 * (location, item, faction, quest, concept).
 *
 * @param {object} card    the parent card (for _origin tracking)
 * @param {object} ent     AI-emitted entity object {name, keys, content}
 * @param {string} type    one of: location | item | faction | quest | concept
 * @param {object} profile conversion profile
 */
function buildNonCharacterEntity(card, ent, type, profile) {
    const name = String(ent?.name || '').trim();
    if (!name) return null;
    const def = entityDefaultsFor(type);
    let content = sanitizeContent(String(ent?.content || ''));
    if (!content) return null;
    if (Number.isFinite(def.wordCap)) content = trimWords(content, def.wordCap);

    const keys = sanitizeKeyList(
        [name, ...(Array.isArray(ent?.keys) ? ent.keys : [])],
        { alwaysInclude: [name], maxKeys: 8 },
    );
    const secondaryKeys = sanitizeSecondaryAgainstPrimary(
        keys,
        Array.isArray(ent?.secondaryKeys) ? ent.secondaryKeys : [],
        4,
    );

    // Capitalised label for the stamp/preview.
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);

    return {
        keys,
        secondaryKeys,
        content,
        comment: '', // populated by caller via makeEntityStamp
        constant: def.constant,
        selective: !def.constant,
        order: def.order,
        position: 0,
        probability: def.probability,
        useProbability: def.probability < 100,
        selectiveLogic: def.selectiveLogic,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        _origin: {
            source: 'entity',
            entityType: type,
            entityTypeLabel: typeLabel,
            entityName: name,
            parentCardName: card?.name,
            profileId: profile.id,
            profileName: profile.name,
            createdAt: new Date().toISOString(),
        },
    };
}
