/**
 * Injects the bulk-action button into ST's #rm_print_characters_pagination
 * toolbar. Hooks ST's BulkEditOverlay to read selectedCharacters.
 */

import { openWizard } from './wizard.js';
import { log, warn } from './core.js';

const BUTTON_ID = 'cardToLoreButton';

/**
 * Find the global ST bulk-edit overlay instance. It's not exported as a
 * module, but ST sets a couple of well-known names on window.
 */
function getBulkOverlay() {
    // BulkEditOverlay.js attaches the instance to window.characterGroupOverlay
    // when the character panel initializes.
    return (
        /** @type {any} */ (window).characterGroupOverlay ||
        /** @type {any} */ (window).BulkEditOverlay?.instance ||
        null
    );
}

function getSelectedIds() {
    const ov = getBulkOverlay();
    const ids = ov?.selectedCharacters || ov?._selectedCharacters || [];
    return Array.isArray(ids) ? [...ids] : [];
}

function ensureButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const container = document.getElementById('rm_print_characters_pagination');
    if (!container) return;
    // Match the ST bulk delete button so it shows/hides with bulk mode.
    // ST toggles `bulkEditOptionElement` items in via inline display:none.
    const btn = document.createElement('i');
    btn.id = BUTTON_ID;
    btn.className = 'fa-solid fa-book-atlas menu_button bulkEditOptionElement';
    btn.title = 'Convert selected cards into a lorebook';
    btn.style.display = 'none';
    btn.addEventListener('click', onButtonClick);

    // Slot after bulkDeleteButton so the order is: select-all, delete, ours
    const deleteBtn = document.getElementById('bulkDeleteButton');
    if (deleteBtn?.parentElement === container) {
        deleteBtn.insertAdjacentElement('afterend', btn);
    } else {
        container.appendChild(btn);
    }
    log('toolbar button injected');
}

function onButtonClick() {
    const ids = getSelectedIds();
    if (ids.length === 0) {
        toastr.info('Select at least one card first (toggle bulk edit mode, then click cards).', 'Card to Lorebook');
        return;
    }
    openWizard(ids).catch(e => {
        console.error('[Card2Lore] wizard crashed', e);
        toastr.error(String(e?.message || e), 'Card to Lorebook');
    });
}

/**
 * Public install hook — called from index.js after APP_READY. Also watches
 * the DOM in case ST rebuilds the character list (which removes our button).
 */
export function installToolbarButton() {
    ensureButton();

    // Watch the character-list container; ST re-renders this on character
    // imports, deletes, paging, etc. Re-inject if our button vanishes.
    const target = document.getElementById('rm_print_characters_pagination');
    if (!target) {
        warn('rm_print_characters_pagination not found; will retry on next list update');
        return;
    }
    const observer = new MutationObserver(() => {
        if (!document.getElementById(BUTTON_ID)) {
            ensureButton();
        }
    });
    observer.observe(target, { childList: true, subtree: false });
}
