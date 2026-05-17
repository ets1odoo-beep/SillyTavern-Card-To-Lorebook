/**
 * Injects the bulk-action button into ST's #rm_print_characters_pagination
 * toolbar. Reads selectedCharacters from ST's exported singleton.
 */

import { characterGroupOverlay } from '/script.js';

import { openWizard } from './wizard.js';
import { log, warn } from './core.js';

const BUTTON_ID = 'cardToLoreButton';

/**
 * Resolve the ST bulk-edit overlay. Tries imported singleton first (the
 * authoritative path — `characterGroupOverlay` is exported from /script.js
 * as `new BulkEditOverlay()`). Falls back to `window` for older builds and
 * to the visual selection on the DOM as a last resort.
 */
function getSelectedIds() {
    // 1) Primary: the imported singleton (set at /script.js line ~395).
    if (characterGroupOverlay) {
        const a = characterGroupOverlay.selectedCharacters;
        if (Array.isArray(a) && a.length > 0) {
            return [...a].map(Number).filter(Number.isFinite);
        }
        const b = characterGroupOverlay._selectedCharacters;
        if (Array.isArray(b) && b.length > 0) {
            return [...b].map(Number).filter(Number.isFinite);
        }
    }

    // 2) Window fallback (older ST or theme overrides).
    const win = /** @type {any} */ (window);
    if (win.characterGroupOverlay?.selectedCharacters) {
        const a = win.characterGroupOverlay.selectedCharacters;
        if (Array.isArray(a) && a.length > 0) {
            return [...a].map(Number).filter(Number.isFinite);
        }
    }

    // 3) DOM fallback — scrape the visually-selected character entities.
    // ST's bulk mode adds `.character_select_state` or similar classes to
    // the selected character entities. Different builds use different class
    // names, so try the common candidates.
    const candidates = document.querySelectorAll(
        '.character_select.bulk_select_checked, ' +
        '.character_select[data-bulk-selected="true"], ' +
        '.entity_block.bulk_select_checked',
    );
    if (candidates.length > 0) {
        const ids = [];
        candidates.forEach(el => {
            const chid = el.getAttribute('chid') ?? el.getAttribute('data-chid');
            const n = Number(chid);
            if (Number.isFinite(n)) ids.push(n);
        });
        if (ids.length > 0) return ids;
    }

    return [];
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
