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
const MODULAR_BASE_INSTRUCTION = `You convert a SillyTavern character card into a MODULAR set of lorebook entries — multiple short entries per character instead of one fat blob. The KEY insight: the World Info engine fires entries based on which key words appear in the recent chat. If every sub-entry has the character's name as a key, then ALL sub-entries fire whenever the name is mentioned — defeating the whole point. So we use a strict key strategy:

- ANCHOR fires on the character's name (constant or selective).
- All OTHER sections fire on SECTION-SPECIFIC CUE WORDS as their primary keys, with the character's name as a SECONDARY key (AND-gated). They only inject when both a cue word AND the character is in the scene.

OUTPUT FORMAT — return strict JSON only, no markdown fences, no commentary:
{
  "name": "<Card name verbatim>",
  "importance": "main|supporting|minor",
  "entries": [
    {
      "section": "anchor|appearance|personality|voice|background|relationships|quirks",
      "keys": ["...primary trigger words..."],
      "secondaryKeys": ["...AND-gated disambiguators..."],
      "content": "...the entry text..."
    },
    ...
  ]
}

(Do not emit order/constant/probability/selectiveLogic — the extension fills those in from section defaults. You only choose the section, content, and keys.)

SECTIONS — produce these (omit a section if the card has nothing for it):

## anchor (REQUIRED) — 1-2 lines: name + species/role + 1 distinctive identifier ("magic warrior with red ponytail")
   keys: card name + EVERY nickname / alias / title mentioned ("Arika", "Riri", "Princess Arika")
   secondaryKeys: (none)
   Goal: always-on identity glue when the character is in scene.

## appearance — physical visual VERBATIM: species, height, build, hair (colour+length+style+texture), eyes (colour+shape), skin/fur/scales, body proportions (bust/dick/ass), marks, non-human features (tail/wings/horns/ears), default outfit layer-by-layer with exact colours/materials.
   keys: visual-cue words ONLY ("looks", "looking", "appears", "appearance", "wearing", "wears", "outfit", "naked", "nude", "stripped", "dressed", "undressed", hair words like "hair", "ponytail", "locks", body words like "breasts", "chest", "ass", "thighs", "skin", and any clothing item types actually present in the card)
   secondaryKeys: card name + ALL nicknames
   Goal: fires when prose describes the character visually.

## personality — traits, attitudes, motivations, fears, values, behaviour patterns. Use the card's own wording.
   keys: emotion/behaviour cue words ("feels", "feeling", "thinks", "thought", "angry", "sad", "happy", "embarrassed", "shy", "scared", "afraid", "jealous", "wants", "needs", "fears", "hesitates", "decides", and any trait words the card uses)
   secondaryKeys: card name + nicknames
   Goal: fires during emotional/decision beats.

## voice — vocal qualities, speech style, vocabulary tier, profanity level, formality, signature phrases. Include 2-3 VERBATIM short example lines from example dialogue if present.
   keys: dialogue cue words ("says", "said", "speaks", "spoke", "voice", "tone", "asks", "asked", "replies", "replied", "whispers", "whispered", "shouts", "shouted", "tells", "told", "mutters", "mumbles", "laughs", "giggles", "sighs")
   secondaryKeys: card name + nicknames
   Goal: fires when the character is speaking.

## background — backstory, origin, current circumstances, world context. Drop OOC/meta.
   keys: named places, factions, organisations, historical events, locations specific to this character's background (from the card text — do NOT invent)
   secondaryKeys: card name + nicknames
   Goal: fires when a relevant place/group/event is mentioned alongside the character.

## relationships — connections to OTHER characters mentioned in the card.
   keys: EVERY OTHER character / group / organisation name mentioned in the card (NOT this character's own name)
   secondaryKeys: card name + nicknames
   Goal: fires only when both this character AND another linked entity are in the scene. selectiveLogic AND_ALL is auto-applied.

## quirks — habits, mannerisms, kinks, taboos, scenario-specific notes that don't fit above but are RP-useful.
   keys: the SPECIFIC quirk nouns/verbs (e.g. "masturbating", "gloves" if the card says she only wears gloves; "tea", "smoking", "drinking" — whatever quirks actually exist in the card text)
   secondaryKeys: card name + nicknames
   Goal: fires when relevant quirk is in the scene.

IMPORTANCE TIER — pick one based on card content:
- main: protagonist / POV-adjacent / explicitly called "main character" or "{{user}}'s romantic partner" / "best friend" etc. Anchor will be constant (always-on when this char is active in chat).
- supporting: recurring named side character. Anchor selective on name.
- minor: bit-part / NPC mentioned in passing. Anchor selective on name with reduced probability.

KEY EXTRACTION RULES — STRICT:
- The character's name belongs ONLY in the ANCHOR section's primary keys. Every other section has it in secondaryKeys.
- Extract cue words from the card's actual text where possible. Do not invent ("wings" only if card mentions wings).
- Include ALL nicknames found in the card.
- For relationships: list every OTHER character / group name that appears in the card — never this character's own name.
- Avoid single-letter or stopword keys ("a", "the", "is", "and"). Use only meaningful tokens.
- Use lowercase except for proper nouns and acronyms.

CONTENT CONSTRAINTS:
- VERBATIM for distinct facts: colour words, body proportions, marks, non-human features, dialogue samples.
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
        // P2.16 cost ceiling — warn at preflight if estimated tokens exceed this.
        // 0 = disabled.
        maxEstimatedTokens: 0,
        // P3.20 per-section overrides — { sectionName: {order?, probability?, ...} }
        sectionOverrides: {},
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
        maxEstimatedTokens: 0,
        sectionOverrides: {},
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
        maxEstimatedTokens: 0,
        sectionOverrides: {},
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
        maxEstimatedTokens: 0,
        sectionOverrides: {},
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
    // P3.22 parallelism — number of cards converted in parallel. Default 1
    // (safe for rate-limited providers). 2-4 useful for high-rate setups.
    queueParallelism: 1,
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
