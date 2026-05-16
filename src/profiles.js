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
const MODULAR_BASE_INSTRUCTION = `You convert a SillyTavern character card into a complete MODULAR WORLD KIT for the World Info engine. A card is centred on one character but typically MENTIONS many entities — other named characters, locations, items, factions, quests, world concepts. We extract them ALL into separately-keyed lorebook entries so each one fires only when the chat mentions it. This is dramatically more token-efficient than dumping the whole card every turn.

THE KEY INSIGHT: the WI engine fires entries based on which keywords appear in recent chat. So:
- Each character's ANCHOR fires on their name.
- Each character's other sections (appearance, voice, etc.) fire on SECTION-SPECIFIC CUE WORDS as primary keys, with that character's name as a SECONDARY key (AND-gated). They only inject when both a cue word AND the character is in scene.
- Non-character entities (locations / items / factions / quests / concepts) fire on their own name + a few related terms as primary keys.

OUTPUT FORMAT — return strict JSON only, no markdown fences, no commentary:
{
  "primaryCharacter": {
    "name": "<the card's main character name verbatim>",
    "importance": "main|supporting|minor",
    "entries": [
      { "section": "anchor|appearance|personality|voice|background|relationships|quirks",
        "keys": [...], "secondaryKeys": [...], "content": "..." },
      ...
    ]
  },
  "otherEntities": [
    { "type": "character", "name": "<other character name>", "importance": "supporting|minor",
      "entries": [ { "section": "...", "keys": [...], "secondaryKeys": [...], "content": "..." }, ... ] },
    { "type": "location", "name": "<place name>", "keys": [...], "content": "..." },
    { "type": "item", "name": "<item name>", "keys": [...], "content": "..." },
    { "type": "faction", "name": "<faction/group name>", "keys": [...], "content": "..." },
    { "type": "quest", "name": "<quest/mission name>", "keys": [...], "content": "..." },
    { "type": "concept", "name": "<world concept>", "keys": [...], "content": "..." }
  ]
}

(Do not emit order/constant/probability/selectiveLogic — the extension fills those in from defaults. You only choose section/type, content, and keys.)

================================================================================
PART A — PRIMARY CHARACTER (the card itself) — 7-section modular split
================================================================================

## anchor (REQUIRED) — 1-2 lines: name + species + GENDER (always state explicitly: "adult female", "young male", "elderly nonbinary humanoid" — never rely on pronouns alone) + role + 1 distinctive identifier ("magic warrior with red ponytail").
   keys: card name + EVERY nickname / alias / title ("Arika", "Riri", "Princess Arika")
   secondaryKeys: (none)
   Goal: always-on identity glue when the character is in scene. Gender must be in the very first line.

## appearance — physical visual VERBATIM. REQUIRED fields if present:
   • GENDER (re-state — "adult female human", "male orc", etc.)
   • Species + apparent age
   • Height + build
   • Hair: colour + length + style + texture + parting + bangs + how style sits (e.g. "tail draped over right shoulder")
   • Eyes (colour + shape)
   • Skin / fur / scales
   • Body proportions VERBATIM (bust/dick/ass/waist/thighs — copy card's wording exactly)
   • LIMB STATUS: "all four limbs intact" OR specify amputations / prosthetics / paralysis
   • Marks (scars / tattoos / piercings / freckles / moles)
   • Non-human features (tail / wings / horns / ears / fur / scales) VERBATIM
   • Default outfit layer-by-layer with footwear (or "barefoot") and underwear visibility
   keys: visual-cue words ONLY ("looks", "appears", "wearing", "wears", "outfit", "naked", "stripped", hair/body part words, clothing item types in card)
   secondaryKeys: card name + nicknames

## personality — traits, attitudes, motivations, fears, values, behaviour. Card's own wording.
   keys: emotion/behaviour cues ("feels", "thinks", "angry", "embarrassed", "wants", "fears" + trait words from card)
   secondaryKeys: card name + nicknames

## voice — vocal quality, speech style, vocabulary, profanity, formality, signatures. Include 2-3 VERBATIM short example dialogue lines.
   keys: dialogue cues ("says", "speaks", "voice", "asks", "whispers", "shouts", "mutters", "laughs")
   secondaryKeys: card name + nicknames

## background — backstory, origin, current circumstances.
   keys: named places / factions / events specific to the character's history (from card text)
   secondaryKeys: card name + nicknames

## relationships — connections to OTHER characters.
   keys: EVERY OTHER character / group name mentioned (NOT this character's own name)
   secondaryKeys: card name + nicknames
   (selectiveLogic AND_ALL auto-applied — fires only when BOTH are in scene.)

## quirks — habits, kinks, taboos, scenario-specific notes that don't fit above.
   keys: the SPECIFIC quirk nouns/verbs from the card
   secondaryKeys: card name + nicknames

IMPORTANCE for primaryCharacter:
- main: protagonist / POV-adjacent / "main character" / "{{user}}'s girlfriend/best friend/etc.". Anchor will be CONSTANT.
- supporting: recurring named side character. Anchor selective on name.
- minor: bit-part. Anchor selective on name with reduced probability.

================================================================================
PART B — OTHER ENTITIES (everything else in the card)
================================================================================

Extract ANY of these that the card mentions by name. Skip generic mentions ("a guard", "the forest"). Skip OOC / creator-meta / RP rules.

### type: "character" — OTHER named characters mentioned in the card with at least a sentence of description.
   Use the same 7-section modular structure as primaryCharacter (with appropriate importance):
     {
       "type": "character",
       "name": "ETSVin",
       "importance": "main|supporting|minor",
       "entries": [ { "section": "anchor", ... }, { "section": "appearance", ... }, ... ]
     }
   Apply the same key strategy — anchor uses name as primary, others use cue words.
   For characters mentioned only briefly: emit only the anchor + 1-2 most relevant sections.

### type: "location" — ANY named place (kingdom, capital, village, building, region, room).
   {
     "type": "location",
     "name": "Royal Palace",
     "keys": ["Royal Palace", "palace", "throne room", any landmarks named inside it],
     "content": "<2-4 sentences: geography, architecture, atmosphere, who lives/works there, what happens there. VERBATIM facts from card.>"
   }

### type: "item" — ANY named item, artifact, equipment, currency, signature object.
   {
     "type": "item",
     "name": "Excalibur",
     "keys": ["Excalibur", "holy sword", material/colour terms, owner's name if explicit in card],
     "content": "<2-3 sentences: physical form, origin/lore, properties, current owner or location.>"
   }

### type: "faction" — ANY named group, organisation, church, guild, kingdom, company, religion.
   {
     "type": "faction",
     "name": "Vaaj Church",
     "keys": ["Vaaj Church", "Vaaj", "priests of Vaaj", member terms, symbol/uniform terms in card],
     "content": "<2-4 sentences: purpose, structure, allies/enemies, current state, key members named in card.>"
   }

### type: "quest" — ANY mission / task / objective the card sets up.
   {
     "type": "quest",
     "name": "Defeat the Demon Lord",
     "keys": ["Demon Lord", "quest", "mission", relevant verbs from objective],
     "content": "<2-3 sentences: objective, stakes, who is involved, current progress / status.>"
   }

### type: "concept" — world-building info NOT covered above: magic systems, currencies, technologies, religions (the doctrine itself, not the church), cultures, ranks/titles, historical events, world rules ("polygamy for adventurers is legal").
   {
     "type": "concept",
     "name": "Pinis Religion",
     "keys": ["Pinis", "Pinis religion", "head priests of Pinis", terms specific to this concept],
     "content": "<2-3 sentences explaining the concept and its relevance.>"
   }

================================================================================
EXTRACTION RULES — STRICT
================================================================================

- Be greedy on entity extraction: if a name appears with even a short description (one sentence), make it an entry. Better too many small entries than missing context.
- Skip throwaway names ("a guard", "the merchant") — no usable description.
- Skip OOC / creator preferences / "Bakunyuu Party NTR will not skip ahead in sex" type RP rules.
- DEDUP: each named entity gets ONE entry (or one per-section for characters).
- Use lowercase keys except for proper nouns and acronyms.
- Avoid single-character, stopword, or punctuation-only keys.
- For relationships sections AND non-character entities, do NOT include the primary character's name in the entity's primary keys — let the entity fire on its own merits.

CONTENT CONSTRAINTS
- VERBATIM for distinct facts: colour words, body proportions, place names, item materials, faction names.
- Hard caps per section:
   character anchor 80w, voice 200w, personality 250w, appearance 350w, background 300w, relationships 200w, quirks 200w.
   location 250w. item 150w. faction 200w. quest 200w. concept 200w.
- Drop creator meta, OOC, [bracketed instructions], author asides.
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
Verbatim physical details. REQUIRED fields if present in the card:
- GENDER (always state explicitly — "adult female", "male", "nonbinary humanoid" — never just rely on pronouns)
- Species + apparent age
- Height + build
- Hair: colour + length + style + texture + parting + bangs/fringe + how it sits (which side ponytail/braid falls)
- Eyes (colour + shape)
- Skin / fur / scales tone
- Body proportions (bust / dick / ass / waist / thighs) VERBATIM — copy card's wording, never paraphrase or resize
- LIMB STATUS — explicit: "all four limbs intact" OR specify amputations / prosthetics / paralysis / mobility aids
- Distinguishing marks (scars / tattoos / piercings / freckles / moles)
- Non-human features (tail / wings / horns / ears / fur / scales) VERBATIM
- Default outfit layer-by-layer with exact colours, materials, fit, and footwear (or "barefoot")
Copy colour words exactly.

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

## Gender & Identity
Explicit gender (adult female / male / nonbinary humanoid / etc.) + apparent age. Always state — never leave it implied by pronouns.

## Species & Build
Species, height, body type, distinct proportions (bust/waist/hip/dick if present).

## Limb Status
"All four limbs intact" OR specify amputations / prosthetics / paralysis / mobility aids (wheelchair, crutches, cane). Never assume completeness.

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
        name: 'RP World Kit (modular characters + entities)',
        builtin: true,
        // Modular = one card → primary character's 7-section split PLUS every
        // OTHER named entity in the card (characters mentioned, locations,
        // items, factions, quests, world concepts) extracted as its own
        // keyed entry. Token-efficient AND comprehensive: a single card can
        // produce 20-40 properly-scoped lorebook entries describing the
        // entire world it implies.
        entrySplitMode: 'modular',
        baseInstruction: MODULAR_BASE_INSTRUCTION,
        includeFields: fieldDefaults(),
        // Word cap is per-section/per-type in modular mode (enforced in the
        // prompt); this is just a safety cap on the full content.
        wordCap: 1800,
        outputFormat: 'json',
        aiConnectionProfile: '',
        alsoExtractCardSummary: true,
        conflictPolicy: 'ask',
        // World Kit returns a much bigger JSON (multiple characters + multiple
        // entities) so we need generous output budget.
        responseLength: 8000,
        maxEstimatedTokens: 0,
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
