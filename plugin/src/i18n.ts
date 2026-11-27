/**
 * Interface language: Chinese when Obsidian runs in Chinese, English otherwise.
 *
 * Text is written in English and translated by lookup, the AlphainZ way:
 * AlphainO's own strings from `zh.ts`, the shared model layer's from
 * AlphainZ's table. A string with no translation shows in English.
 */
import { getLanguage } from 'obsidian';
import { ZH_CN } from '@alphainz/i18n/zh-CN';
import { ZH } from './zh';

export type TranslationVars = Record<string, string | number>;

export function isChinese(): boolean {
    try {
        return /^zh(\b|[-_])/i.test(getLanguage());
    } catch {
        return false;
    }
}

function englishOf(source: string): string {
    const at = source.indexOf('@@');
    return at < 0 ? source : source.slice(0, at);
}

function fill(template: string, vars?: TranslationVars): string {
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
}

/** Interface text in Obsidian's language. `source` is the English, with `{name}` placeholders. */
export function t(source: string, vars?: TranslationVars): string {
    if (!isChinese()) return fill(englishOf(source), vars);
    return fill(ZH[source] ?? ZH_CN[source] ?? englishOf(source), vars);
}

/** `t` for a count: the singular text for one, the plural for any other number (AlphainZ's `tn`). */
export function tn(count: number, singular: string, plural: string, vars?: TranslationVars): string {
    return t(count === 1 ? singular : plural, { count, ...vars });
}

/** Whole sentences one after another: separated by a space in English, run together in Chinese. */
export function joinSentences(sentences: string[]): string {
    return sentences.join(isChinese() ? '' : ' ');
}
