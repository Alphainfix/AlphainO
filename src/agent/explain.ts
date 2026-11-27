/**
 * "Explain" on a selection, as AlphainZ's reader offers it: the passage goes to
 * the chat with a set question, sent at once. The question is a setting
 * (Settings → Explain prompt); left empty, this default is used, in the
 * interface language.
 */
import type { PrefStore } from '../settings';
import { t } from '../i18n';

export const DEFAULT_EXPLAIN_PROMPT =
    'Explain the selected passage in plain language. Provide context for any technical terms or domain-specific concepts. If it refers to other notes or other work, briefly explain that context too.';

/** The question "Explain" asks. */
export function explainPrompt(prefs: Pick<PrefStore, 'string'>): string {
    return prefs.string('explainPrompt') || t(DEFAULT_EXPLAIN_PROMPT);
}
