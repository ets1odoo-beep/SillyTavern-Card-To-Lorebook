/**
 * Card to Lorebook — entry point.
 *
 * Lifecycle:
 *   1. APP_READY: mount settings panel, install toolbar button, register slash
 *      command.
 *   2. MutationObserver inside toolbarButton.js re-injects the button if ST
 *      rebuilds the character pagination row (e.g. on import/delete/paging).
 */

import { characterGroupOverlay, eventSource, event_types } from '/script.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '/scripts/slash-commands/SlashCommandArgument.js';

import { installToolbarButton } from './src/toolbarButton.js';
import { mountSettingsPanel } from './settings.js';
import { settings, getProfile, listProfiles, setSelectedProfile } from './src/profiles.js';
import { openWizard } from './src/wizard.js';
import { rebuildRoster, removeStampedEntries } from './src/lorebookIO.js';
import { installRuntimeHooks } from './src/runtimeHooks.js';
import { log, warn, err, EXT_KEY } from './src/core.js';

function getSelectedCharacterIdsFromOverlay() {
    const ov = characterGroupOverlay || /** @type {any} */ (window).characterGroupOverlay;
    const ids = ov?.selectedCharacters;
    return Array.isArray(ids) ? [...ids].map(Number).filter(Number.isFinite) : [];
}

function registerSlashCommand() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'cards-to-lore',
            callback: async (args) => {
                if (!settings().enabled) {
                    toastr.warning('Card to Lorebook is disabled. Enable it in extension settings.', 'Card to Lorebook');
                    return '';
                }
                if (args?.profile) {
                    const target = listProfiles().find(p => p.id === args.profile || p.name === args.profile);
                    if (target) setSelectedProfile(target.id);
                }
                const ids = getSelectedCharacterIdsFromOverlay();
                if (ids.length === 0) {
                    toastr.info('Enable bulk-edit and select cards first, then re-run /cards-to-lore.', 'Card to Lorebook');
                    return '';
                }
                await openWizard(ids);
                return '';
            },
            namedArgumentList: [
                SlashCommandArgument.fromProps({
                    name: 'profile',
                    description: 'conversion profile id or name (optional)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
            ],
            helpString: 'Open the Card-to-Lorebook wizard for the currently bulk-selected characters.',
        }));
        log('slash command /cards-to-lore registered');
    } catch (e) {
        warn('slash command registration failed', e);
    }

    // P2.17 cleanup slash command — remove all card2lore-stamped entries
    // from the named lorebook. Hand-written entries are preserved.
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'cards-to-lore-clean',
            callback: async (args) => {
                const book = String(args?.book || '').trim();
                if (!book) {
                    toastr.warning('Usage: /cards-to-lore-clean book=<lorebookName>', 'Card to Lorebook');
                    return '';
                }
                try {
                    const removed = await removeStampedEntries(book);
                    toastr.success(`Removed ${removed} card2lore entries from "${book}".`, 'Card to Lorebook');
                    return String(removed);
                } catch (e) {
                    toastr.error(String(e?.message || e), 'Cleanup failed');
                    return '';
                }
            },
            namedArgumentList: [
                SlashCommandArgument.fromProps({
                    name: 'book',
                    description: 'lorebook name (required)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                }),
            ],
            helpString: 'Remove every entry stamped by Card to Lorebook from the named lorebook. Hand-written entries are kept.',
        }));
        log('slash command /cards-to-lore-clean registered');
    } catch (e) {
        warn('cleanup slash command registration failed', e);
    }

    // /cards-to-lore-roster — manually rebuild the World Roster entry for a
    // given lorebook. Run this any time after editing entries by hand to keep
    // the always-on roster in sync.
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'cards-to-lore-roster',
            callback: async (args) => {
                const book = String(args?.book || '').trim();
                if (!book) {
                    toastr.warning('Usage: /cards-to-lore-roster book=<lorebookName>', 'Card to Lorebook');
                    return '';
                }
                try {
                    const res = await rebuildRoster(book);
                    if (res.wrote) {
                        toastr.success(`Roster rebuilt for "${book}" (covers ${res.entryCount} entries).`, 'Card to Lorebook');
                    } else {
                        toastr.info(`No card2lore entries in "${book}" — roster cleared.`, 'Card to Lorebook');
                    }
                    return String(res.entryCount || 0);
                } catch (e) {
                    toastr.error(String(e?.message || e), 'Roster rebuild failed');
                    return '';
                }
            },
            namedArgumentList: [
                SlashCommandArgument.fromProps({
                    name: 'book',
                    description: 'lorebook name (required)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                }),
            ],
            helpString: 'Rebuild the always-active "World Roster" entry for the named lorebook so the AI sees a current table of contents of every card2lore entity in the book.',
        }));
        log('slash command /cards-to-lore-roster registered');
    } catch (e) {
        warn('roster slash command registration failed', e);
    }
}

function init() {
    log('init');

    eventSource.on(event_types.APP_READY, async () => {
        try {
            await mountSettingsPanel();
        } catch (e) {
            warn('settings mount failed', e);
        }
        try {
            // Slight delay so ST has time to attach the BulkEditOverlay singleton.
            setTimeout(() => installToolbarButton(), 250);
        } catch (e) {
            warn('toolbar button install failed', e);
        }
        try {
            registerSlashCommand();
            installRuntimeHooks();
        } catch (e) {
            warn('slash command install failed', e);
        }
    });

    // Also try to mount if the extensions panel becomes visible later (some
    // ST builds emit a separate event for the extensions settings UI).
    try {
        eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, () => {
            setTimeout(() => mountSettingsPanel().catch(() => {}), 200);
        });
    } catch { /* event may not exist on older ST */ }
}

try {
    init();
} catch (e) {
    err('fatal init error', e);
}
