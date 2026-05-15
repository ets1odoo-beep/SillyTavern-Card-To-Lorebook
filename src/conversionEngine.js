/**
 * Conversion engine — runs the AI call that converts one card's prompt text
 * into a structured lorebook entry. Handles connection-profile switching,
 * robust JSON parse, retries, and per-call abort.
 */

import { generateQuietPrompt } from '/script.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';

import { buildCardPromptText } from './cardExtractor.js';
import { robustJsonParse, trimWords, log, warn } from './core.js';

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

function buildPrompt(profile, cardText) {
    const baseInstruction = String(profile?.baseInstruction || '').trim();
    return [
        baseInstruction,
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

// Section → default config when the AI omits a field.
const SECTION_DEFAULTS = {
    anchor:        { order: 100, probability: 100, constantFor: ['main'],            wordCap: 80  },
    appearance:    { order: 300, probability: 100, constantFor: [],                  wordCap: 350 },
    personality:   { order: 200, probability: 100, constantFor: [],                  wordCap: 250 },
    voice:         { order: 200, probability: 100, constantFor: [],                  wordCap: 200 },
    background:    { order: 400, probability: 90,  constantFor: [],                  wordCap: 300 },
    relationships: { order: 400, probability: 100, constantFor: [],                  wordCap: 200 },
    quirks:        { order: 350, probability: 100, constantFor: [],                  wordCap: 200 },
};

function sectionDefaultsFor(section, importance) {
    const def = SECTION_DEFAULTS[String(section || '').toLowerCase()] || SECTION_DEFAULTS.background;
    return {
        order: def.order,
        probability: def.probability,
        constant: def.constantFor.includes(String(importance || '').toLowerCase()),
        wordCap: def.wordCap,
    };
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

    const prompt = buildPrompt(profile, cardText);
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
    let keys = Array.isArray(parsed?.keys) ? parsed.keys : [name];
    keys = keys.map(k => String(k || '').trim()).filter(Boolean);
    if (!keys.length) keys = [name];

    let content = String(parsed?.content || '').trim();
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

    const out = [];
    for (const raw of rawEntries) {
        const section = String(raw?.section || 'misc').toLowerCase();
        const def = sectionDefaultsFor(section, importance);

        // Keys: always include cardName as first key, then AI suggestions,
        // dedup case-insensitive.
        const seen = new Set();
        const keys = [];
        const addKey = (k) => {
            const v = String(k || '').trim();
            if (!v) return;
            const lower = v.toLowerCase();
            if (seen.has(lower)) return;
            seen.add(lower);
            keys.push(v);
        };
        addKey(cardName);
        if (Array.isArray(raw?.keys)) raw.keys.forEach(addKey);

        const secondaryKeys = Array.isArray(raw?.secondaryKeys)
            ? raw.secondaryKeys.map(s => String(s || '').trim()).filter(Boolean)
            : [];

        // Constant: AI override > defaults-by-importance.
        const constant = typeof raw?.constant === 'boolean' ? raw.constant : def.constant;
        const order = Number.isFinite(raw?.order) ? raw.order : def.order;
        const probability = Number.isFinite(raw?.probability) ? raw.probability : def.probability;

        let content = String(raw?.content || '').trim();
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
    const cleaned = String(rawText || '')
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, '')
        .trim();
    const name = card?.name || 'Unknown';
    let content = cleaned;
    if (Number.isFinite(profile.wordCap)) content = trimWords(content, profile.wordCap);
    return {
        keys: [name],
        secondaryKeys: [],
        content,
        comment: '',
        constant: false,
        selective: true,
        order: 100,
        position: 0,
        _origin: {
            source: 'card-fallback',
            cardName: name,
            profileId: profile.id,
            profileName: profile.name,
            createdAt: new Date().toISOString(),
        },
    };
}
