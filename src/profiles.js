/**
 * Conversion profile management — defaults + CRUD + resolution.
 *
 * A profile bundles together: AI prompt template, which card fields to feed
 * the AI, output JSON shape, word cap, AI connection profile binding, conflict
 * policy, and a few behavioral knobs. Users start with three built-in profiles
 * and can clone/edit to make their own.
 */

import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

import { EXT_KEY, log } from './core.js';

// All card fields the extension knows about. Order matters — it's the order
// they're presented in the settings UI and in the AI prompt.
export const CARD_FIELDS = [
    { key: 'description',             label: 'Description',              defaultOn: true },
    { key: 'personality',             label: 'Personality',              defaultOn: true },
    { key: 'scenario',                label: 'Scenario',                 defaultOn: true },
    { key: 'first_mes',               label: 'First message',            defaultOn: true },
    { key: 'mes_example',             label: 'Example dialogue',         defaultOn: true },
    { key: 'creator_notes',           label: 'Creator notes',            defaultOn: false },
    { key: 'system_prompt',           label: 'System prompt',            defaultOn: false },
    { key: 'post_history_instructions', label: 'Post-history instructions', defaultOn: false },
    { key: 'tags',                    label: 'Tags',                     defaultOn: true },
    { key: 'alternate_greetings',     label: 'Alternate greetings',      defaultOn: false },
];

function fieldDefaults(overrides = {}) {
    const out = {};
    for (const f of CARD_FIELDS) out[f.key] = f.defaultOn;
    return { ...out, ...overrides };
}

/* ============================================================
 * MODULAR mode prompt — one card → many sub-entries with correct
 * keys, order, constant flag per section. This is the default
 * for the "RP Character" profile because it's the only way to
 * use the token budget efficiently during long chats: each beat
 * only triggers the sub-entries it actually needs.
 * ============================================================ */
const MODULAR_BASE_INSTRUCTION = `You convert a SillyTavern character card into a MODULAR set of lorebook entries — multiple short entries per character instead of one fat blob. This lets the World Info engine inject ONLY the sub-entry the current scene needs, not the entire character sheet every turn.

OUTPUT FORMAT — return strict JSON only, no markdown fences, no commentary:
{
  "name": "<Card name verbatim>",
  "importance": "main|supporting|minor",
  "entries": [
    {
      "section": "anchor|appearance|personality|voice|background|relationships|quirks",
      "keys": ["...primary trigger words..."],
      "secondaryKeys": ["...optional disambiguators..."],
      "constant": true|false,
      "order": 100,
      "probability": 100,
      "content": "...the entry text..."
    },
    ...
  ]
}

SECTIONS — produce these (omit a section if the card has nothing for it):

## anchor (REQUIRED) — 1-2 lines: name + species/role + most distinctive identifier
   keys: card name + every nickname/alias mentioned in the card
   constant: TRUE if importance=main, FALSE if supporting/minor
   order: 100  (highest — anchor fires first)
   probability: 100

## appearance — physical visual: species, height, build, hair (colour+length+style+texture), eyes (colour+shape), skin/fur/scales, body proportions VERBATIM (bust/dick/ass/etc), marks, non-human features (tail/wings/horns/ears), default outfit layer-by-layer with exact colours/materials
   keys: card name + visual-cue words found in the card ("looks", "appears", "wearing", "wears", "outfit", clothing types mentioned, hair colour words, body parts mentioned)
   constant: false
   order: 300
   probability: 100

## personality — traits, attitudes, emotional tendencies, motivations, fears, values, behaviour patterns. Use the card's own wording.
   keys: card name + emotion/behaviour words mentioned ("feels", "thinks", "wants", "fears", trait words)
   constant: false
   order: 200
   probability: 100

## voice — vocal qualities, speech style, vocabulary tier, profanity level, formality, signature phrases. Include 2-3 VERBATIM short example lines from example dialogue when present.
   keys: card name + dialogue cues ("says", "speaks", "voice", "tone", "asks", "replies", "whispers")
   constant: false
   order: 200
   probability: 100

## background — backstory, origin, current circumstances, world context. Drop only-RP-meta content.
   keys: card name + named places/factions/people that appear in the card text
   constant: false
   order: 400
   probability: 90

## relationships — connections to other characters mentioned in the card
   keys: card name + EVERY other character/group/organisation name mentioned
   secondaryKeys: card name (so this only fires when both this character AND another mentioned entity are in the scene)
   constant: false
   order: 400
   probability: 100

## quirks — habits, mannerisms, kinks, taboos, scenario-specific notes, things that don't fit above but are RP-useful
   keys: card name + the specific quirk/habit nouns
   constant: false
   order: 350
   probability: 100

IMPORTANCE TIER — pick one:
- main: card describes a protagonist / POV-adjacent character that should be active whenever they're in the scene (anchor constant=true)
- supporting: recurring side character (anchor constant=false but order=100, fires on name mention)
- minor: bit-part / NPC mentioned in passing (anchor constant=false, probability dropped slightly)

KEY EXTRACTION RULES:
- Always include the card name as the FIRST key of every section.
- Extract trigger words from the card's actual text, not from imagination. If the card never mentions "wings", don't put "wings" in keys.
- Include nicknames, alternate names, titles ("Princess Arika", "Riri") found in the card.
- For relationships section, list every OTHER character / group / faction name that appears in the card.
- Keys are case-insensitive in ST by default. Use lowercase except for proper nouns.

CONTENT CONSTRAINTS:
- VERBATIM extraction for distinct facts: copy colour words, body proportions, marks, non-human features EXACTLY as written. Never paraphrase, never resize.
- Hard cap per section: anchor 80 words, voice 200, personality 250, appearance 350, background 300, relationships 200, quirks 200.
- Drop creator-meta / OOC / [bracketed instructions] / author asides.
- Output ONLY the JSON object. No prose around it. No code fences.`;

// The flat-extraction system prompt — one entry per card, single content blob.
// Kept as an alternative mode for users who want one-row-per-card simplicity
// at the cost of token efficiency.
const DEFAULT_BASE_INSTRUCTION = `You convert a SillyTavern character card into one structured lorebook entry suitable for roleplay context injection.

GOAL: Extract verbatim facts from the card and reorganise them into a clean structured entry. Do not paraphrase distinct visual details, body proportions, or marks. Do not invent details not present in the card.

OUTPUT FORMAT — return strict JSON only, no markdown fences, no commentary:
{
  "name": "<Card name verbatim>",
  "keys": ["<Card name>", "<any nicknames or aliases found in the card text>"],
  "content": "<the structured entry, see sections below>"
}

CONTENT STRUCTURE — use these H2 sections, in this order. Omit any section that has no source material.

## Appearance
Verbatim physical details: species, age, height, build, hair (colour + length + style + texture), eyes (colour + shape), skin/fur/scales tone, body proportions, distinguishing marks, non-human features (tail/wings/horns/ears). Copy colour words exactly. Never resize or paraphrase bust/height/figure.

## Personality
Traits, attitudes, emotional tendencies, motivations, fears, values, behaviour patterns. Use the card's own wording where possible.

## Voice & Dialogue
Vocal qualities, speech style, vocabulary tier, signature phrases. Include 2-3 short example lines from the card's example dialogue if available.

## Background
Backstory, origin, current circumstances, relationships to other characters, world context relevant to who they are.

## Quirks & Notes
Habits, kinks, taboos, scenario-specific notes, anything that doesn't fit above but is RP-useful.

CONSTRAINTS:
- Hard cap: 600 words in content.
- If the card is huge, prioritise Appearance, then Personality, then Voice & Dialogue.
- Drop creator meta-commentary (OOC notes, [bracketed instructions], author asides) unless directly RP-relevant.
- Names mentioned multiple times in the card's text are good key candidates.
- Output ONLY the JSON object. No prose around it. No code fences.`;

const VISUAL_BASE_INSTRUCTION = `You extract ONLY the visual identity of a SillyTavern character card for image-prompt reference.

OUTPUT — strict JSON:
{
  "name": "<Card name>",
  "keys": ["<Card name>"],
  "content": "<structured visual sheet>"
}

CONTENT — use these sections, omit if empty. Copy visual details verbatim. Never paraphrase colours, sizes, or non-human traits.

## Species & Build
Species, height, body type, distinct proportions (bust/waist/hip/dick if present).

## Hair
Colour, length, style, texture, parting, bangs.

## Face & Eyes
Eye colour and shape, face shape, features, mouth, brows.

## Skin / Fur / Scales
Tone and texture.

## Non-Human Features
Tail, wings, horns, ears, claws, fangs, antennae.

## Marks
Scars, tattoos, piercings, freckles, moles.

## Default Outfit
Each piece with exact colour + material + cut.

## Voice Color (if present in card text)
Hex code or descriptive colour.

CONSTRAINT: Hard cap 400 words. Output ONLY the JSON. No fences. No prose.`;

const VOICE_BASE_INSTRUCTION = `You extract the personality, voice, and dialogue style of a SillyTavern character card.

OUTPUT — strict JSON:
{
  "name": "<Card name>",
  "keys": ["<Card name>"],
  "content": "<structured personality + voice sheet>"
}

CONTENT — sections, omit if empty:

## Personality
Core traits, attitudes, motivations, emotional tendencies, behaviour patterns. Use card's wording.

## Voice & Speech Style
Tone, formality, vocabulary tier, profanity level, signature phrases or verbal tics. Include 3-4 short verbatim sample lines from example dialogue if present.

## Behaviour & Quirks
Habits, mannerisms, reflexive reactions, what they always/never do.

## Triggers & Tensions
What angers them, what they avoid, what they pursue. Relationship dynamics.

CONSTRAINT: Hard cap 450 words. Skip visual appearance entirely (that lives elsewhere). Output ONLY the JSON. No fences. No prose.`;

const DEFAULT_PROFILES = [
    {
        id: 'rp_default',
        name: 'RP Character (default, modular)',
        builtin: true,
        // Modular = one card → many sub-entries (anchor, appearance, personality,
        // voice, background, relationships, quirks) each with their own keys,
        // constant flag, and order. Token-efficient on long chats.
        entrySplitMode: 'modular',
        baseInstruction: MODULAR_BASE_INSTRUCTION,
        includeFields: fieldDefaults(),
        // Word cap is per-section in modular mode (enforced in the prompt);
        // this is just a safety cap on the full content.
        wordCap: 1800,
        outputFormat: 'json',
        aiConnectionProfile: '',
        alsoExtractCardSummary: true,
        conflictPolicy: 'ask', // ask | skip | overwrite | append
        responseLength: 3500,
    },
    {
        id: 'rp_flat',
        name: 'RP Character (flat — one entry per card)',
        builtin: true,
        entrySplitMode: 'flat',
        baseInstruction: DEFAULT_BASE_INSTRUCTION,
        includeFields: fieldDefaults(),
        wordCap: 600,
        outputFormat: 'json',
        aiConnectionProfile: '',
        alsoExtractCardSummary: true,
        conflictPolicy: 'ask',
        responseLength: 1500,
    },
    {
        id: 'visual_only',
        name: 'Visual Identity Only',
        builtin: true,
        entrySplitMode: 'flat',
        baseInstruction: VISUAL_BASE_INSTRUCTION,
        includeFields: fieldDefaults({
            personality: false,
            scenario: false,
            first_mes: false,
            mes_example: false,
            tags: false,
            alternate_greetings: false,
        }),
        wordCap: 400,
        outputFormat: 'json',
        aiConnectionProfile: '',
        alsoExtractCardSummary: true,
        conflictPolicy: 'ask',
        responseLength: 1000,
    },
    {
        id: 'personality_voice',
        name: 'Personality + Voice Only',
        builtin: true,
        entrySplitMode: 'flat',
        baseInstruction: VOICE_BASE_INSTRUCTION,
        includeFields: fieldDefaults({
            description: false,
            scenario: false,
            first_mes: false,
            creator_notes: false,
            system_prompt: false,
            post_history_instructions: false,
            tags: false,
        }),
        wordCap: 450,
        outputFormat: 'json',
        aiConnectionProfile: '',
        alsoExtractCardSummary: true,
        conflictPolicy: 'ask',
        responseLength: 1200,
    },
];

export const DEFAULT_SETTINGS = {
    enabled: true,
    profiles: structuredClone(DEFAULT_PROFILES),
    selectedProfileId: 'rp_default',
    debug: false,
    // Run-time defaults — remembered between runs.
    lastDestination: { mode: 'new', name: '' }, // mode: new|existing|chat|character
    queueDelayMs: 0,
    // Phase 3: smart entry splitting (one|fields|ai)
    entrySplitMode: 'one',
};

export function settings() {
    extension_settings[EXT_KEY] = Object.assign({}, DEFAULT_SETTINGS, extension_settings[EXT_KEY] || {});
    const s = extension_settings[EXT_KEY];
    // Heal profiles array — if user wiped it via console, restore defaults.
    if (!Array.isArray(s.profiles) || s.profiles.length === 0) {
        s.profiles = structuredClone(DEFAULT_PROFILES);
    }
    // Ensure built-in profiles still exist (user can delete them; we let them).
    // Ensure selected profile points at something real.
    if (!s.profiles.find(p => p.id === s.selectedProfileId)) {
        s.selectedProfileId = s.profiles[0]?.id || 'rp_default';
    }
    return s;
}

export function listProfiles() {
    return settings().profiles;
}

export function getProfile(id) {
    return settings().profiles.find(p => p.id === id) || null;
}

export function getSelectedProfile() {
    return getProfile(settings().selectedProfileId) || settings().profiles[0];
}

export function setSelectedProfile(id) {
    const p = getProfile(id);
    if (!p) return false;
    settings().selectedProfileId = id;
    saveSettingsDebounced();
    return true;
}

export function saveProfile(profile) {
    const s = settings();
    const i = s.profiles.findIndex(p => p.id === profile.id);
    if (i === -1) s.profiles.push(profile);
    else s.profiles[i] = profile;
    saveSettingsDebounced();
}

export function deleteProfile(id) {
    const s = settings();
    const i = s.profiles.findIndex(p => p.id === id);
    if (i === -1) return false;
    s.profiles.splice(i, 1);
    if (s.selectedProfileId === id) s.selectedProfileId = s.profiles[0]?.id || 'rp_default';
    saveSettingsDebounced();
    return true;
}

export function cloneProfile(id) {
    const src = getProfile(id);
    if (!src) return null;
    const copy = structuredClone(src);
    copy.id = `custom_${Date.now().toString(36)}`;
    copy.name = `${src.name} (copy)`;
    copy.builtin = false;
    settings().profiles.push(copy);
    saveSettingsDebounced();
    log(`Cloned profile "${src.name}" → "${copy.name}"`);
    return copy;
}

export function resetDefaultProfiles() {
    const s = settings();
    const fresh = structuredClone(DEFAULT_PROFILES);
    // Remove existing built-ins, keep user clones.
    s.profiles = s.profiles.filter(p => !p.builtin);
    // Prepend fresh built-ins.
    s.profiles = [...fresh, ...s.profiles];
    saveSettingsDebounced();
}
