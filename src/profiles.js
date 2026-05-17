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
const MODULAR_BASE_INSTRUCTION = `You convert a SillyTavern character card into a complete MODULAR WORLD KIT for the World Info engine. A card describes an entire world through one character's lens. We extract EVERY meaningful entity — characters, places, items, factions, quests, events, documents, world rules, languages/cultures, abilities, ranks, recurring scenes — and emit each as its own keyed lorebook entry so each one fires only when the chat mentions it.

WHY: the WI engine fires entries based on keywords. If everything is in one big blob, it always fires. With proper modular split + AND-gated secondary keys, each piece injects only when its specific cue word AND the entity-in-scope appears. Massive token savings on long chats.

OUTPUT — strict JSON only, no markdown fences:
{
  "primaryCharacter": {
    "name": "<verbatim>",
    "importance": "main|supporting|minor",
    "entries": [ { "section": "anchor|appearance|personality|voice|background|relationships|quirks|appearance_variant", "keys":[...], "secondaryKeys":[...], "content":"...", "variantName":"<only for appearance_variant>" }, ... ]
  },
  "otherEntities": [
    { "type": "<see TYPE TABLE>", "name": "<entity name>", "keys":[...], "secondaryKeys":[...], "content":"...", "importance":"main|supporting|minor (only for type=character)", "entries":[...] /* only for type=character */, "linkedTo":["<entity name>", ...] /* optional cross-refs */ }
  ]
}

(Do not emit order/constant/probability/selectiveLogic/group/sticky/cooldown — the extension fills those from the table below.)

TYPE TABLE — pick the right type, emit ANY that exist in the card:

| type                | what it covers                                                                | keys (primary)                              | secondary  |
|---------------------|-------------------------------------------------------------------------------|---------------------------------------------|------------|
| character           | a named person, NPC, antagonist, ally. Uses sectioned entries (see PART A).   | (per section)                               | (per sec.) |
| location            | named place — kingdom / capital / city / village / building / room / region   | place name + landmarks + nearby places      | —          |
| faction             | named group / organisation / church / guild / kingdom / company / religion    | faction name + member terms + symbols       | —          |
| item                | named artifact / equipment / signature object / currency unit                 | item name + material + owner's name         | —          |
| quest               | mission / objective / task / arc the card sets up                             | quest name + objective verbs + giver        | —          |
| event               | historical event / war / coronation / cataclysm / festival / specific past date | event name + date/era + key participants  | —          |
| document            | letter / journal / edict / prophecy / song / contract / known book            | doc title + key excerpt words               | —          |
| rule                | in-fiction world rule / scenario constraint / law / custom (NOT OOC author meta) | rule terms                                | —          |
| concept             | other world facts: magic systems, technologies, philosophies, calendars       | concept terms                               | —          |
| language            | named language / dialect / writing system                                     | lang name + speakers                        | —          |
| culture             | named culture / race-as-population / ethnic group                             | culture name + members                      | —          |
| ability             | named spell / power / technique / skill, with named caster                    | ability name                                | caster name |
| rank_title          | named rank / title / honorific (Lord / Archmage / Pope / Captain)             | rank word + holder names                    | —          |
| scene               | recurring scene template / set piece (tavern visit, throne audience)           | scene cue words                             | —          |

CHARACTER vs other types: characters get the 7-section split (PART A). All other types are ONE entry per entity with name + keys + content.

================================================================================
PART A — character sections (used for primaryCharacter AND for type=character others)
================================================================================

anchor (required) — 1-2 lines: full name + species + GENDER (explicit: "adult female", "young male", never just pronouns) + role + 1 distinctive identifier.
   keys: card name + every nickname/alias/title
   secondaryKeys: (none)

appearance — physical VERBATIM. Required fields if present: GENDER restated, species + age, height + build, hair (colour/length/style/texture/parting/bangs), eyes (colour/shape), skin/fur/scales, body proportions VERBATIM (bust/dick/ass/waist/thighs), LIMB STATUS only if non-standard (amputation/prosthetic/paralysis), marks, non-human features, default outfit layer-by-layer + footwear + underwear visibility.
   keys: visual cue words ONLY ("looks", "wearing", "outfit", "naked", hair/body words, clothing types from card)
   secondaryKeys: card name + nicknames

personality — traits, motivations, fears, values, behaviour. Card's own wording.
   keys: emotion/behaviour cues + trait words from card
   secondaryKeys: card name + nicknames

voice — vocal qualities, speech style, profanity, formality, signatures. Include 2-3 VERBATIM short example lines from mes_example if present.
   keys: dialogue cues ("says", "speaks", "asks", "whispers", "shouts")
   secondaryKeys: card name + nicknames

background — backstory, origin, current circumstances.
   keys: named places/factions/events specific to this character (from card text)
   secondaryKeys: card name + nicknames

relationships — connections to OTHER characters. ONE relationship per linked entity.
   keys: EVERY OTHER character/group name mentioned (NOT this character's name)
   secondaryKeys: card name + nicknames
   (AND_ALL auto-applied; fires only when BOTH are in scene.)

quirks — habits, kinks, taboos, scenario-specific notes (in-fiction; not OOC meta).
   keys: specific quirk nouns/verbs from card
   secondaryKeys: card name + nicknames

appearance_variant (optional, one per variant) — if card describes alternate outfits / forms / transformations ("battle armour", "cocktail dress", "naked", "monster form"). Use this when there's clearly more than one wardrobe/form, otherwise stick with the default appearance entry.
   variantName: short label ("formal", "armour", "naked", "monster form")
   keys: variant cue words ("armour", "armor", "battle", "formal", "dress", "naked", etc.)
   secondaryKeys: card name + nicknames

IMPORTANCE TIER for any character:
- main: protagonist / POV-adjacent / "{{user}}'s girlfriend/best friend/etc". Anchor will be CONSTANT.
- supporting: recurring named side character.
- minor: bit-part / NPC mentioned in passing.

================================================================================
PART B — non-character entities (one entry per entity)
================================================================================

For each non-character entity: pick TYPE from the table, supply name + keys + 2-4 sentences of VERBATIM content from the card.

For type=ability use secondaryKeys = caster name (so the ability fires only when its owner is in scene).

For type=relationship-style entries between OTHER characters that aren't either-side's anchor, you can also emit a standalone entry of type=character with section=relationships listing both — but normally the character's own relationships section covers this.

================================================================================
EXTRACTION RULES — STRICT
================================================================================

- Be GREEDY: extract every named entity with at least a short description. Better too many small entries than missing context.
- SKIP truly throwaway names ("a guard", "the merchant" with no usable description).
- IN-FICTION vs OOC: scenario constraints like "polygamy is legal for adventurers" or "characters cannot leave the capital without permission" are WORLD RULES → emit as type=rule. Only skip pure RP-meta author preferences ("don't skip ahead in sex", "use vivid prose") that have no in-fiction grounding.
- Name belongs ONLY in anchor's primary keys for characters. Non-anchor sections use cue words primary + name secondary.
- For non-character entities, name IS the primary key (no AND-gating).
- LINK entities via the optional "linkedTo" array on any entry. E.g. character "Marah" linkedTo=["Vaaj Church", "Vaaj Temple"]. Used to build the roster's cross-references.
- DEDUP within this response: don't emit two entries for the same entity.
- Use lowercase keys except for proper nouns and acronyms.
- Avoid stopword keys ("the", "a", "and", "is").

CONTENT CAPS (auto-enforced; AI just stay close):
  character anchor 80w · voice 200w · personality 250w · appearance 350w · background 300w · relationships 200w · quirks 200w · appearance_variant 300w
  location 250w · faction 200w · item 150w · quest 200w · event 250w · document 250w · rule 150w · concept 200w · language 150w · culture 200w · ability 150w · rank_title 100w · scene 250w

Output ONLY the JSON object. No prose around it. No code fences.`;

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
        generateRoster: true,
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
        generateRoster: true,
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
        generateRoster: true,
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
        generateRoster: true,
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
