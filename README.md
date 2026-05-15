# Card to Lorebook (SillyTavern extension)

Bulk-convert one or more character cards into a SillyTavern lorebook (World Info) in a single guided run. Pick cards from the character list, click a button, walk a wizard, get a clean lorebook.

## What it does

- Hooks the **bulk-edit toolbar** on the character list (the row with select-all / delete) and adds a "Convert selected cards to lorebook" button.
- Opens a wizard: pick a **conversion profile**, pick an **AI connection profile**, pick a **destination** (new lorebook / existing global / chat-bound / character-embedded), preview generated entries, edit them, commit.
- For each card, **imports any embedded `character_book` entries verbatim** (no API call) and **generates one AI-extracted summary entry** for the card itself, structured by H2 sections (Appearance / Personality / Voice / Background / Quirks).
- All extension-generated entries are stamped in their `comment` field so they can be identified and bulk-removed later.

## Profiles

Three built-in profiles, all editable in the extension settings page:

- **RP Character (default)** — full extraction across all card fields, 600-word cap, structured sections.
- **Visual Identity Only** — appearance/anatomy/outfit only, useful for image-prompt reference.
- **Personality + Voice Only** — behaviour, dialogue style, no appearance.

Clone any profile to make your own with custom prompts, field toggles, and AI connection bindings.

## Slash command

```
/cards-to-lore                  Open the wizard for the currently bulk-selected cards.
/cards-to-lore profile=<id>     Pre-select a conversion profile.
```

## Destinations

| Mode | What it does |
|---|---|
| New lorebook | Creates a fresh file, default name `Cards YY-MM-DD HHmm` |
| Existing global | Appends to a lorebook already in your global list |
| Bind to current chat | Creates a lorebook and writes `chat_metadata.world_info` |
| Character embedded book | Writes into `character.data.character_book` (in-memory; saved on next character save) |

## Conflict policy

When appending to an existing lorebook and an entry stamped for the same card already exists:

- **Ask per entry** (default) — diff popup
- **Skip** — keep existing
- **Overwrite** — replace content, preserve UID/order
- **Append as new** — write alongside with a `(copy)` suffix

## Safety

- Sequential queue, configurable delay between calls (default 0).
- Cancel mid-batch — already completed entries still go to preview.
- Per-card failures are isolated; the queue continues.
- Cards with no extractable content (under the active profile's field toggles) skip with a toast.
- 4-pass JSON parser tolerates the usual AI emission breakage.
- Never mutates character cards. Read-only on cards, write-only to lorebooks.

## Installation

This extension lives in `data/default-user/extensions/SillyTavern-Card-To-Lorebook/`. ST auto-loads it on startup.

If you want to install fresh from a clone of this repo, place the folder under `data/<your-user>/extensions/`.
