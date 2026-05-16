# Card to Lorebook

Bulk-convert SillyTavern character cards into **token-efficient modular lorebook entries** in one guided run. Select cards from the character list, click a button, walk a wizard, get a clean lorebook.

## What it does

- Hooks the **bulk-edit toolbar** on ST's character list and adds a "Convert selected cards to lorebook" button.
- Opens a 7-step wizard: source review → profile + AI connection → destination → pre-flight confirmation → progress queue → preview + edit → done.
- For each card, **imports any embedded `character_book` entries verbatim** and **generates a structured AI summary** split into up to 7 sub-entries per character.
- All extension-generated entries are stamped in their `comment` field so they can be identified and bulk-removed later.

## Modular mode — the point

Default profile uses **modular mode**: each card produces up to **7 sub-entries** with section-specific keys, order, constant flag, probability, and selective logic. This means the World Info engine only injects the sub-entry the current scene actually needs — instead of dumping the entire character sheet whenever the name appears.

| Section | Primary keys | Secondary (AND-gated) | Order | Probability | Constant (main importance) | selectiveLogic |
|---|---|---|---|---|---|---|
| **anchor** | card name + nicknames | — | 100 | 100% | ✓ | AND_ANY |
| **voice** | dialogue cues ("says", "voice", "asks") | card name + nicknames | 200 | 100% | — | AND_ALL |
| **personality** | emotion/behaviour cues ("feels", "thinks", trait words) | card name + nicknames | 200 | 100% | — | AND_ALL |
| **appearance** | visual cues ("hair", "wearing", "eyes", clothing types) | card name + nicknames | 300 | 100% | — | AND_ALL |
| **quirks** | specific quirk nouns from the card | card name + nicknames | 350 | 100% | — | AND_ALL |
| **background** | named places / factions / events | card name + nicknames | 400 | 90% | — | AND_ALL |
| **relationships** | other character / group names | card name + nicknames | 400 | 100% | — | AND_ALL |

**Why this works:** the AND-gated secondary keys mean each non-anchor section only fires when both a cue word AND the character is in scene. Mentioning the character's name alone activates only the **anchor** (~80 words of identity glue). Mentioning their appearance fires only the **appearance** section. Massive token savings on long chats.

Also available: **flat mode** (one entry per card) for users who prefer the simpler structure, and **Visual Identity Only** / **Personality + Voice Only** focused profiles.

## Built-in profiles

- **RP Character (default, modular)** — full 7-section split, the recommended choice.
- **RP Character (flat)** — one-entry-per-card legacy mode.
- **Visual Identity Only** — appearance / anatomy / outfit sheet (flat).
- **Personality + Voice Only** — no appearance (flat).

All editable, cloneable, exportable as JSON. Bind a specific AI connection profile per conversion profile. Add **custom sections** beyond the built-in 7 (e.g. "Combat Stats", "Inventory") and the AI will produce them.

## Destinations

| Mode | What it does |
|---|---|
| **New lorebook** | Creates a fresh file, default name `Cards YY-MM-DD HHmm` |
| **Existing global** | Appends/updates entries in a global lorebook |
| **Bind to current chat** | Creates a lorebook and writes `chat_metadata.world_info` |
| **Character embedded book** | Writes into `character.data.character_book` AND persists via `/api/characters/merge-attributes` |

## Conflict policy

When appending to an existing book and a stamped entry exists:

- **Ask per entry** (default) — diff popup
- **Skip** — keep existing
- **Overwrite** — replace content, preserve UID/order
- **Append as new** — write alongside with `(copy)` suffix

Stamps are section-scoped (`[card2lore:card:Appearance] Arika`), so overwriting `Arika - Appearance` leaves `Arika - Voice` alone. Strict exact-name matching prevents `Arika` colliding with `Arika and Friends`.

## "Redo from scratch"

Wizard's destination step has a **Redo from scratch** checkbox — when committing to an existing lorebook, it first removes every `[card2lore:*]` stamped entry from that book. Hand-written entries are preserved.

## Settings page features

- **Profile editor** with all knobs: prompt template, field toggles, word cap, AI connection binding, conflict policy default, **per-section overrides** (order/probability/constant/wordCap), **cost ceiling** warning.
- **Test on one card** — run the current profile against a single character and see the raw entries before bulk-running 50 cards.
- **Profile export / import** — JSON download/upload for sharing.
- **Custom sections** — define new section types beyond the built-in 7.
- **Reset built-ins** if you mess them up.

## Queue behavior

- **Sequential by default** with configurable inter-call delay (rate-limit friendly).
- **Parallel workers** (1–8) for fast providers — toggle in extension settings.
- **Cancel mid-batch** — completed entries still go to preview.
- **Per-card failure isolation** — one bad card doesn't stop the queue.
- **Per-card timer** in the progress view so you can see what's hung.
- **"No extractable content"** skip + toast for empty cards.

## Smart features

- **Auto-detect importance** — scans card text for cues ("main character", "protagonist", "POV", "{{user}}'s girlfriend/best friend") and pre-suggests the importance tier. AI can still override.
- **Cross-character relationship linking** — after the queue runs, detects bidirectional links between selected cards (Arika mentions ETSVin AND vice versa) and ensures each direction has the other character as a primary key in its relationships section.
- **Key hygiene** — all AI-generated keys are filtered for stopwords ("the", "and", "is", pronouns), too-short tokens, and duplicates between primary/secondary. Capped at 8 primary / 6 secondary per entry.
- **Content sanitization** — strips stray markdown fences, `<details>` from thinking output, dangerous HTML; collapses blank-line runs. AI sloppy output is normalised before it hits the lorebook.
- **Robust JSON parse** — 4-pass repair (strict → strip comments + trailing commas → escape literal newlines → truncate at last balanced brace).
- **Embedded book hygiene** — caps each embedded entry at 4 KB, dedups duplicates, drops entries whose only content is the card name.

## Slash commands

```text
/cards-to-lore                            Open the wizard for the currently bulk-selected cards.
/cards-to-lore profile=<id>               Pre-select a conversion profile.
/cards-to-lore-clean book=<name>          Remove every card2lore-stamped entry from <name>. Hand-written kept.
```

## Event emissions

Other extensions can subscribe:

- `cards-to-lore.queue.done` — fires after the queue finishes (before preview).
- `cards-to-lore.committed` — fires after entries are written to the destination.

```js
eventSource.on('cards-to-lore.committed', ({ destination, result, entriesCount }) => {
    console.log(`Wrote ${result.written} entries to ${result.target}`);
});
```

## Install

ST → Extensions → Install Extension from URL → `https://github.com/ets1odoo-beep/SillyTavern-Card-To-Lorebook`

Or clone into `data/<your-user>/extensions/SillyTavern-Card-To-Lorebook/`.

## Safety

- Never mutates character cards (except the character-embedded destination, which is explicit).
- Sequential queue + cancellation + per-card isolation.
- Card with no extractable content under the profile's filters → skip + toast, never crash the queue.
- Cost ceiling pre-flight warning to avoid surprise bills.
- All AI-generated content is sanitised before writing.

## Tested invariants

The modular parser is verified against 19 invariants including:

- Anchor primary key contains card name + nicknames; constant for main importance.
- Non-anchor sections have card name in secondaryKeys, NOT primary.
- All non-anchor sections use `selectiveLogic: AND_ALL` (3).
- Stopwords ("the", "a", "and") stripped from extracted keys.
- Markdown fences and `<details>` tags stripped from content.
- Section-specific cue words (e.g. "hair" → appearance, "says" → voice) preserved as primary.
- Word caps enforced per section.
