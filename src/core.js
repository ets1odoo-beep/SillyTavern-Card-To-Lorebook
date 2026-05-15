/**
 * Core constants + utilities used across the extension.
 */

import { extension_settings } from '/scripts/extensions.js';

export const EXT_KEY = 'SillyTavern-Card-To-Lorebook';
export const ENTRY_STAMP_CARD = 'card2lore:card';
export const ENTRY_STAMP_EMBEDDED = 'card2lore:embedded';

// Console-friendly logger. Silent unless debug toggled on in settings.
export function log(...args) {
    if (extension_settings?.[EXT_KEY]?.debug) {
        console.log('[Card2Lore]', ...args);
    }
}
export function warn(...args) { console.warn('[Card2Lore]', ...args); }
export function err(...args)  { console.error('[Card2Lore]', ...args); }

/**
 * Format a Date as `YY-MM-DD HHmm` for default lorebook naming.
 * Compact, sortable, includes time so multiple bulk runs same day don't clash.
 */
export function formatStampShort(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const yy = pad(date.getFullYear() % 100);
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const mi = pad(date.getMinutes());
    return `${yy}-${mm}-${dd} ${hh}${mi}`;
}

export function defaultLorebookName(date = new Date()) {
    return `Cards ${formatStampShort(date)}`;
}

/**
 * Robust 4-pass JSON parser, ported from RPG HUD + ff4-vir. Recovers from
 * common AI emission errors:
 *   Pass 1: strict JSON.parse
 *   Pass 2: strip block + line comments + trailing commas
 *   Pass 3: escape literal newlines inside string values
 *   Pass 4: truncate at last balanced top-level brace
 * Only throws if all 4 passes fail.
 *
 * @param {string} rawContent
 * @returns {{ data: any, recovered: boolean, repairAttempts: number }}
 */
export function robustJsonParse(rawContent) {
    let attempts = 0;
    let lastErr = null;
    let content = String(rawContent || '')
        .replace(/^```(?:json|c2l)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

    try {
        attempts++;
        return { data: JSON.parse(content), recovered: false, repairAttempts: attempts };
    } catch (e) { lastErr = e; }

    try {
        attempts++;
        const cleaned = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
            .replace(/,\s*([\}\]])/g, '$1');
        return { data: JSON.parse(cleaned), recovered: true, repairAttempts: attempts };
    } catch (e) { lastErr = e; }

    try {
        attempts++;
        const repaired = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
            .replace(/,\s*([\}\]])/g, '$1')
            .replace(/(?<="[^"\n]*)\n(?=[^"\n]*")/g, '\\n');
        return { data: JSON.parse(repaired), recovered: true, repairAttempts: attempts };
    } catch (e) { lastErr = e; }

    try {
        attempts++;
        const cleaned = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
            .replace(/,\s*([\}\]])/g, '$1');
        let depth = 0, inStr = false, escape = false, firstBalanced = -1;
        for (let i = 0; i < cleaned.length; i++) {
            const ch = cleaned[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { firstBalanced = i; break; }
                if (depth < 0) break;
            }
        }
        if (firstBalanced > 0) {
            return {
                data: JSON.parse(cleaned.slice(0, firstBalanced + 1)),
                recovered: true,
                repairAttempts: attempts,
            };
        }
    } catch (e) { lastErr = e; }

    throw lastErr || new Error('JSON parse failed after 4 passes');
}

/**
 * Crude token estimator — ~4 chars per token. Good enough for cost preview.
 */
export function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}

/**
 * Trim a string to N words, preserving sentence structure where possible.
 */
export function trimWords(text, maxWords) {
    const words = String(text || '').trim().split(/\s+/);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(' ') + '…';
}

/**
 * Slugify for a lorebook name suggestion or identifier.
 */
export function slugify(s) {
    return String(s || '')
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .trim()
        .slice(0, 64);
}
