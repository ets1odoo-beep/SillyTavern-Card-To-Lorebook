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

function buildPrompt(profile, cardText, importanceHint, baseContext) {
    const baseInstruction = String(profile?.baseInstruction || '').trim();
    const hint = importanceHint
        ? `\n\nIMPORTANCE HINT (auto-detected from card text): "${importanceHint}". You may override if the card text clearly suggests a different tier.`
        : '';
    const adaptationAddendum = baseContext
        ? buildAdaptationAddendum(baseContext) + '\n---\n\n'
        : '';
    return [
        adaptationAddendum + baseInstruction + hint,
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
// NOT_ANY (2) / AND_ALL (3) constants.
export const SELECTIVE_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

// ST world_info_position constants. We use these to land different entity
// types in different prompt regions: rules / languages / cultures go in
// "WI Before" (the world frame); quest-current goes in Author's Note;
// scene state goes IN_CHAT near the user message; etc.
export const POSITION = {
    BEFORE_CHAR:  0, // before character defs (good for setting / world rules)
    AFTER_CHAR:   1, // after character defs (good for background lore)
    AN_TOP:       2, // Author's Note top (surfaces immediately above chat)
    AN_BOTTOM:    3, // Author's Note bottom
    AT_DEPTH:     4, // IN_CHAT at `depth` messages from end
    EM_TOP:       5, // Example messages top
    EM_BOTTOM:    6, // Example messages bottom
};

// Section → default config. Anchor uses card name as PRIMARY key; everything
// else uses cue words as primary and card name as SECONDARY (AND-gated).
// constant: true only for anchor of main importance (always-on identity glue).
export const SECTION_DEFAULTS = {
    anchor: {
        order: 100, probability: 100, constantFor: ['main'], wordCap: 80,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY, nameAsPrimary: true,
        position: POSITION.AT_DEPTH, depth: 4, matchWholeWords: true,
        excludeRecursion: true, // anchors shouldn't trigger further recursion
        ignoreBudgetFor: ['main'], // main anchors survive budget trimming
    },
    appearance: {
        order: 300, probability: 100, constantFor: [], wordCap: 350,
        selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false,
        position: POSITION.AT_DEPTH, depth: 1, vectorized: false,
    },
    personality: {
        order: 200, probability: 100, constantFor: [], wordCap: 250,
        selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false,
        position: POSITION.AT_DEPTH, depth: 2,
    },
    voice: {
        order: 200, probability: 100, constantFor: [], wordCap: 200,
        selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false,
        position: POSITION.AT_DEPTH, depth: 1,
    },
    background: {
        order: 400, probability: 90, constantFor: [], wordCap: 300,
        selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false,
        position: POSITION.AFTER_CHAR, vectorized: true, scanDepth: 100,
        excludeRecursion: true,
    },
    relationships: {
        order: 400, probability: 100, constantFor: [], wordCap: 200,
        selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false,
        position: POSITION.AT_DEPTH, depth: 2,
        cooldown: 3, // don't re-fire every turn once activated
    },
    quirks: {
        order: 350, probability: 100, constantFor: [], wordCap: 200,
        selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false,
        position: POSITION.AT_DEPTH, depth: 3,
    },
    appearance_variant: {
        // Wardrobe variants compete via a per-character WI group so only one
        // outfit is "currently equipped" per scene. Stamps with variantName.
        order: 280, probability: 100, constantFor: [], wordCap: 300,
        selectiveLogic: SELECTIVE_LOGIC.AND_ALL, nameAsPrimary: false,
        position: POSITION.AT_DEPTH, depth: 1,
        groupTemplate: 'appearance:{cardName}', // {cardName} replaced at build time
        groupWeight: 100, sticky: 4,
    },
};

/**
 * Non-character entity type defaults. Each non-character entity becomes one
 * lorebook entry with these settings unless the AI overrides them. position +
 * depth + sticky + cooldown + scanDepth + matchWholeWords + vectorized +
 * excludeRecursion are leveraged per type for the right WI placement.
 */
export const ENTITY_TYPE_DEFAULTS = {
    location: {
        order: 250, probability: 100, constant: false, wordCap: 250,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.AT_DEPTH, depth: 4,
        matchWholeWords: true,
    },
    item: {
        order: 350, probability: 100, constant: false, wordCap: 150,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.AT_DEPTH, depth: 4,
        matchWholeWords: true,
    },
    faction: {
        order: 300, probability: 100, constant: false, wordCap: 200,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.AT_DEPTH, depth: 4,
        matchWholeWords: true,
    },
    quest: {
        order: 400, probability: 90, constant: false, wordCap: 200,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.AN_TOP, // surface active objectives near chat
        matchWholeWords: true,
        ignoreBudget: false,
    },
    event: {
        order: 420, probability: 90, constant: false, wordCap: 250,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.AT_DEPTH, depth: 4,
        vectorized: true, scanDepth: 100, excludeRecursion: true,
    },
    document: {
        order: 430, probability: 90, constant: false, wordCap: 250,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.AT_DEPTH, depth: 4,
        vectorized: true, excludeRecursion: true,
    },
    rule: {
        order: 60, probability: 100, constant: true, wordCap: 150,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.BEFORE_CHAR, // sets the world frame
        sticky: 99, vectorized: false, excludeRecursion: true,
    },
    concept: {
        order: 450, probability: 90, constant: false, wordCap: 200,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.AFTER_CHAR,
        vectorized: true, scanDepth: 100, excludeRecursion: true,
    },
    language: {
        order: 470, probability: 80, constant: false, wordCap: 150,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.BEFORE_CHAR,
        vectorized: true, excludeRecursion: true,
    },
    culture: {
        order: 460, probability: 80, constant: false, wordCap: 200,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.BEFORE_CHAR,
        vectorized: true, excludeRecursion: true,
    },
    ability: {
        // Abilities fire only when the caster is in scene (AND_ALL secondary).
        order: 320, probability: 100, constant: false, wordCap: 150,
        selectiveLogic: SELECTIVE_LOGIC.AND_ALL,
        position: POSITION.AT_DEPTH, depth: 2,
        cooldown: 2, matchWholeWords: true,
    },
    rank_title: {
        order: 480, probability: 100, constant: false, wordCap: 100,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.AFTER_CHAR,
        matchWholeWords: true,
    },
    scene: {
        order: 380, probability: 95, constant: false, wordCap: 250,
        selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
        position: POSITION.AT_DEPTH, depth: 3,
        sticky: 6,
    },
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
export async function convertOneCard(card, profile, signal, baseContext = null) {
    if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');

    const cardText = buildCardPromptText(card, profile);
    if (!cardText) throw new Error('No extractable content for card');

    const importanceHint = detectImportance(card);
    const prompt = buildPrompt(profile, cardText, importanceHint, baseContext);
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

        // Per-character group string for appearance_variant. Template
        // groupTemplate = 'appearance:{cardName}' → 'appearance:Arika'.
        const group = def.groupTemplate
            ? def.groupTemplate.replace('{cardName}', cardName)
            : '';
        const variantName = section === 'appearance_variant'
            ? String(raw?.variantName || '').trim()
            : '';

        // Cross-reference targets the AI may have indicated.
        const linkedTo = Array.isArray(raw?.linkedTo)
            ? raw.linkedTo.map(s => String(s || '').trim()).filter(Boolean)
            : [];

        out.push({
            keys,
            secondaryKeys,
            content,
            comment: '', // populated by caller via makeCardStamp(...)
            constant,
            selective: !constant,
            order,
            position: Number.isFinite(def.position) ? def.position : 0,
            depth: Number.isFinite(def.depth) ? def.depth : null,
            probability,
            useProbability: probability < 100,
            selectiveLogic,
            // Phase B — WI field richness
            scanDepth: Number.isFinite(def.scanDepth) ? def.scanDepth : null,
            caseSensitive: null,
            matchWholeWords: typeof def.matchWholeWords === 'boolean' ? def.matchWholeWords : null,
            vectorized: !!def.vectorized,
            excludeRecursion: !!def.excludeRecursion,
            sticky: Number.isFinite(def.sticky) ? def.sticky : null,
            cooldown: Number.isFinite(def.cooldown) ? def.cooldown : null,
            group,
            groupWeight: Number.isFinite(def.groupWeight) ? def.groupWeight : null,
            ignoreBudget: Array.isArray(def.ignoreBudgetFor)
                ? def.ignoreBudgetFor.includes(importance)
                : false,
            _origin: {
                source: 'card',
                section,
                sectionLabel,
                importance,
                cardName,
                variantName,
                linkedTo,
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

    // Cross-reference targets the AI may have indicated.
    const linkedTo = Array.isArray(ent?.linkedTo)
        ? ent.linkedTo.map(s => String(s || '').trim()).filter(Boolean)
        : [];

    // Phase F — emit a stable automationId for actionable entity types
    // (quests/abilities/scenes) so users can hook Quick Reply buttons.
    const automationId =
        type === 'quest' || type === 'ability' || type === 'scene'
            ? `card2lore.${type}.${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
            : '';

    return {
        keys,
        secondaryKeys,
        content,
        comment: '', // populated by caller via makeEntityStamp
        constant: !!def.constant,
        selective: !def.constant,
        order: def.order,
        position: Number.isFinite(def.position) ? def.position : 0,
        depth: Number.isFinite(def.depth) ? def.depth : null,
        probability: def.probability,
        useProbability: def.probability < 100,
        selectiveLogic: def.selectiveLogic,
        // Phase B — WI field richness propagated for every entity type
        scanDepth: Number.isFinite(def.scanDepth) ? def.scanDepth : null,
        caseSensitive: null,
        matchWholeWords: typeof def.matchWholeWords === 'boolean' ? def.matchWholeWords : null,
        vectorized: !!def.vectorized,
        excludeRecursion: !!def.excludeRecursion,
        sticky: Number.isFinite(def.sticky) ? def.sticky : null,
        cooldown: Number.isFinite(def.cooldown) ? def.cooldown : null,
        group: '',
        groupWeight: null,
        ignoreBudget: !!def.ignoreBudget,
        automationId,
        _origin: {
            source: 'entity',
            entityType: type,
            entityTypeLabel: typeLabel,
            entityName: name,
            parentCardName: card?.name,
            linkedTo,
            profileId: profile.id,
            profileName: profile.name,
            createdAt: new Date().toISOString(),
        },
    };
}

/* ============================================================
 * Phase D — Embedded character_book reprocessing
 * ============================================================ */

/**
 * Heuristic: is this embedded book poorly keyed and worth reprocessing
 * through the modular pipeline? Used by mode='auto'.
 *
 * Bad-key indicators:
 *   - >50% of entries are constant=true (defeats keyword filtering)
 *   - average content length > 800 chars (giant blobs)
 *   - average primary keys < 2 (under-keyed)
 *   - keys include common stopwords or 1-2 char tokens
 */
export function looksPoorlyKeyed(embeddedEntries) {
    if (!Array.isArray(embeddedEntries) || embeddedEntries.length === 0) return false;
    const n = embeddedEntries.length;
    let constants = 0, totalContentChars = 0, totalKeys = 0, badKeys = 0;
    const stopwords = new Set(['the', 'a', 'and', 'is', 'or', 'of', 'to']);
    for (const e of embeddedEntries) {
        if (e.constant) constants++;
        totalContentChars += String(e.content || '').length;
        const keys = Array.isArray(e.keys) ? e.keys : [];
        totalKeys += keys.length;
        for (const k of keys) {
            const lower = String(k || '').trim().toLowerCase();
            if (!lower || lower.length < 3 || stopwords.has(lower)) badKeys++;
        }
    }
    const constantRatio = constants / n;
    const avgContent = totalContentChars / n;
    const avgKeys = totalKeys / n;
    const badKeyRatio = totalKeys > 0 ? badKeys / totalKeys : 1;
    return constantRatio > 0.5 || avgContent > 800 || avgKeys < 2 || badKeyRatio > 0.3;
}

/**
 * Reprocess each embedded character_book entry through the AI modular
 * pipeline. We treat each embedded entry as a synthetic mini-card whose
 * "description" is the entry content and whose "name" is the entry comment.
 * Returns an array of internal entries.
 *
 * @param {object[]} embeddedEntries  normalised embedded entries (from cardExtractor)
 * @param {object} card               parent card (used for parentCardName)
 * @param {object} profile            conversion profile
 * @param {AbortSignal} [signal]
 */
export async function reprocessEmbeddedBook(embeddedEntries, card, profile, signal) {
    const out = [];
    for (const emb of embeddedEntries) {
        if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');
        const syntheticCard = {
            name: emb.comment || emb.keys?.[0] || 'Lore Entry',
            description: emb.content,
        };
        const syntheticProfile = {
            ...profile,
            // Include only description; embedded entries don't have other card fields.
            includeFields: { description: true },
        };
        try {
            const sub = await convertOneCard(syntheticCard, syntheticProfile, signal);
            for (const e of sub) {
                e._origin.source = 'embedded-reprocessed';
                e._origin.parentCardName = card?.name;
            }
            out.push(...sub);
        } catch (e) {
            warn(`reprocess embedded "${syntheticCard.name}" failed — passing through verbatim`);
            // Fall back to the verbatim entry shape for this one.
            out.push({
                keys: emb.keys,
                secondaryKeys: emb.secondaryKeys,
                content: emb.content,
                comment: '',
                constant: emb.constant,
                selective: emb.selective,
                order: emb.order,
                position: emb.position,
                probability: 100,
                useProbability: false,
                selectiveLogic: SELECTIVE_LOGIC.AND_ANY,
                _origin: { source: 'embedded', parentCardName: card?.name },
            });
        }
    }
    return out;
}

/* ============================================================
 * Phase E — AI merge for conflict policy
 * ============================================================ */

/**
 * Merge two entries (existing + incoming) describing the same entity via the AI:
 * union the facts, preserve verbatim distinct details from each, dedupe
 * sentences. Returns a new internal entry with merged content + key union.
 *
 * @param {object} existing  the entry already in the lorebook (ST shape)
 * @param {object} incoming  the new internal entry to merge
 * @param {object} profile   for AI connection + cap accounting
 * @param {AbortSignal} [signal]
 */
export async function mergeEntriesViaAI(existing, incoming, profile, signal) {
    if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');

    const prompt = `You merge two lorebook entries describing the SAME entity. Union the facts, preserve verbatim distinct details from each, dedupe sentences, keep the most informative phrasing. Output strict JSON only.

OUTPUT: { "keys": [...], "content": "..." }

ENTITY: ${incoming.comment || existing.comment || 'unknown'}

EXISTING CONTENT:
${existing.content || ''}

INCOMING CONTENT:
${incoming.content || ''}

EXISTING KEYS: ${(existing.key || []).join(', ')}
INCOMING KEYS: ${(incoming.keys || []).join(', ')}

Merge them. Output ONLY the JSON.`;

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
        reply = await generateQuietPrompt({
            quietPrompt: prompt,
            responseLength: Number(profile.responseLength) || 1500,
            jsonSchema: { type: 'object', properties: { keys: { type: 'array' }, content: { type: 'string' } } },
            trimToSentence: false,
        });
    } finally {
        if (previousProfile) await switchAiProfile(previousProfile);
    }

    let parsed;
    try { parsed = robustJsonParse(reply).data; }
    catch (e) {
        warn('mergeEntriesViaAI parse failed — concatenating verbatim');
        // Fallback: append incoming content after existing with a separator.
        const merged = sanitizeContent(`${existing.content}\n\n${incoming.content}`);
        const mergedKeys = sanitizeKeyList(
            [...(existing.key || []), ...(incoming.keys || [])],
            { maxKeys: 12 },
        );
        return { ...incoming, keys: mergedKeys, content: merged };
    }

    const mergedContent = sanitizeContent(String(parsed?.content || incoming.content));
    const aiKeys = Array.isArray(parsed?.keys) ? parsed.keys : [];
    const mergedKeys = sanitizeKeyList(
        [...aiKeys, ...(existing.key || []), ...(incoming.keys || [])],
        { maxKeys: 12 },
    );

    return {
        ...incoming,
        keys: mergedKeys,
        content: mergedContent,
        _origin: {
            ...(incoming._origin || {}),
            mergedFrom: [existing._c2lOrigin?.parentCardName, incoming._origin?.parentCardName].filter(Boolean),
        },
    };
}

/* ============================================================
 * Phase I — Adaptive migration
 * ============================================================ */

/**
 * Build the base-world adaptation prompt addendum, prepended to the modular
 * base instruction when an adaptationSource lorebook is selected.
 *
 * @param {object} baseContext  { worldName, roster, relevantEntries, constantEntries }
 */
export function buildAdaptationAddendum(baseContext) {
    if (!baseContext || !baseContext.worldName) return '';
    const roster = String(baseContext.roster || '');
    const relevant = (baseContext.relevantEntries || [])
        .map(e => `### ${e.name}\n${e.content}`).join('\n\n');
    const constants = (baseContext.constantEntries || [])
        .map(e => `### ${e.name}\n${e.content}`).join('\n\n');

    const parts = [
        `ADAPTATION MODE — you are adapting this card to fit an EXISTING WORLD.`,
        ``,
        `BASE WORLD: "${baseContext.worldName}"`,
        ``,
        `BASE WORLD ROSTER (what's already in this world):`,
        roster || '(none)',
        ``,
        `BASE WORLD CORE FACTS (always-on context):`,
        constants || '(none)',
        ``,
        `BASE WORLD RELEVANT ENTRIES (matched by card keywords):`,
        relevant || '(none)',
        ``,
        `ADAPTATION RULES:`,
        `- PRESERVE the character's core identity: name, gender, age, body, core personality traits, voice, signature behaviours, kinks.`,
        `- ADAPT to the base world: profession/role, outfit/equipment, hobbies, technology level, location/origin, language, modern references, hairstyle if culturally specific. A modern graphic designer in a fantasy guild world becomes a guild scribe or illuminator; her hoodie becomes a guild tabard; her PC gaming becomes copying illuminated manuscripts.`,
        `- LINK to existing base-world entities: if the base world has a "Mage's Guild" and this character has a creative profession, make her a member. Reuse base-world locations / factions / items instead of inventing equivalents.`,
        `- DON'T DUPLICATE entities the base world already has — reference them by their existing name in linkedTo arrays, do not re-emit them in otherEntities.`,
        `- NEW entities OK if the card has uniquely new info that doesn't conflict (a pet, a signature trinket). They go in otherEntities as usual.`,
        `- For each adapted fact, optionally set _adapted: true and _original: "<the original card fact>" on the entry so the preview can show a diff.`,
        `- Add type=character relationships entries linking the new character to each base-world entity she's now connected to.`,
        ``,
        `Now proceed with the normal modular World Kit extraction below.`,
        ``,
    ];
    return parts.join('\n');
}
