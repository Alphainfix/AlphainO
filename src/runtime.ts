/**
 * The host side of the shared packages: the runtime adapter (settings and
 * logging) and the translators that turn their English into Obsidian's
 * language. Installed once, when the plugin loads.
 */
import { apiVersion } from 'obsidian';
import { setRuntimeAdapter } from '@beaver/agent-core/platform/runtime';
import { setTranslator as setCoreTranslator } from '@beaver/agent-core/i18n/translate';
import { setTranslator as setLlmTranslator } from '@beaver/agent-llm/i18n';
import { setTranslator as setUiTranslator } from '@beaver/agent-ui/i18n';
import { ZH_CN } from '@alphainz/i18n/zh-CN';
import type { PrefStore } from './settings';
import { isChinese, joinSentences, t, type TranslationVars } from './i18n';

/**
 * The shared React layer's text in Chinese: AlphainZ's own wording first, so a
 * component both plugins show (the provider cards, the Ollama guide) reads the
 * same in both; AlphainO's table where AlphainZ's has nothing.
 */
function sharedUiText(source: string, vars?: TranslationVars): string {
    if (!isChinese() || !Object.prototype.hasOwnProperty.call(ZH_CN, source)) return t(source, vars);
    const template = ZH_CN[source];
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
}

/**
 * The shared layers name where AlphainZ keeps a setting ("Settings → Advanced",
 * "设置 → 模型 → 服务商"). AlphainO's settings are one page, so those places
 * read as AlphainO's settings, in either language.
 */
export function atAlphainOSettings(text: string): string {
    return text
        .replace(/Settings → (?:Advanced|Model)(?: → [A-Z][A-Za-z ]*[a-z])?/g, 'AlphainO’s settings')
        .replace(/设置 → (?:高级|模型)(?: → [^\s，。、；：）)]+)?/g, 'AlphainO 设置');
}

/** `t` for the shared layers' text, with AlphainZ's settings places put as AlphainO's. */
function sharedText(source: string, vars?: TranslationVars): string {
    return atAlphainOSettings(t(source, vars));
}

export function installRuntime(prefs: PrefStore, development: boolean): void {
    setRuntimeAdapter({
        debug(message) {
            if (development) console.debug(`[AlphainO] ${message}`);
        },
        isDevelopment: () => development,
        // AlphainO has no preference namespace of its own: qualified and
        // unqualified keys are the same store.
        getPref: (key) => prefs.get(key),
        setPref: (key, value) => prefs.set(key, value),
        clearPref: (key) => prefs.clear(key),
        getPluginPref: (key) => prefs.get(key),
        setPluginPref: (key, value) => prefs.set(key, value),
        hostVersion: () => apiVersion,
    });
    setCoreTranslator(sharedText);
    setLlmTranslator({ t: sharedText, joinSentences });
    setUiTranslator((source, vars) => atAlphainOSettings(sharedUiText(source, vars)));
}
