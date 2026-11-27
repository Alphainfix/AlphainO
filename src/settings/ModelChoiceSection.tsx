/**
 * Settings → Model: the model the chat uses, chosen from every model the
 * configured providers offer — AlphainZ's Model section, on the same list the
 * model menu beside the message box shows.
 */
import React from 'react';
import { retireChoice } from '@beaver/agent-llm/openAICompatible';
import { Icon, InformationCircleIcon } from '@beaver/agent-ui/icons';
import { SectionDescription, SectionLabel, SettingsGroup } from '@beaver/agent-ui/settings/SettingsElements';
import { useModelsVersion, useSettingsHost } from '@beaver/agent-ui/settings/host';
import { availableModels } from '../agent/models';
import { t } from '../i18n';
import type { SettingsPlugin } from './obsidianHost';

export const Note: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="text-sm font-color-secondary display-flex flex-row items-start gap-1">
        <Icon icon={InformationCircleIcon} className="scale-90 mt-015 font-color-secondary" />
        <span>{children}</span>
    </div>
);

/** A model the user can actually select: a provider plus one of its models. */
interface ModelChoice {
    /** `provider::model`, the value carried by the dropdown. */
    value: string;
    label: string;
}

export const ModelChoiceSection: React.FC<{ plugin: SettingsPlugin }> = ({ plugin }) => {
    const host = useSettingsHost();
    // Re-read whenever the list is rebuilt: a key added above, the model menu.
    useModelsVersion();
    const provider = plugin.prefs.string('llmProvider');
    const model = plugin.prefs.string('llmModel');

    // The same list the model menu shows, so the two cannot disagree.
    const choices: ModelChoice[] = availableModels(plugin)
        .filter((entry) => entry.id.startsWith('local-') && entry.snapshot)
        .map((entry) => ({ value: `${String(entry.provider)}::${entry.snapshot}`, label: entry.name }));

    // A stored pair naming a retired provider or model is shown as its
    // successor, as the model menu shows it.
    const resolved = retireChoice(provider, model);
    const currentValue = resolved.provider ? `${resolved.provider}::${resolved.model}` : '';
    // A stored model that is not in the list (a new release, or a key since
    // removed) is still offered, so opening this page cannot silently change
    // which model is in use.
    const showsCurrent = !currentValue || choices.some((choice) => choice.value === currentValue);

    const applyModel = (value: string) => {
        const [nextProvider, nextModel] = value.split('::');
        host.setPref('llmProvider', nextProvider ?? '');
        host.setPref('llmModel', nextModel ?? '');
        host.models.refresh();
    };

    return (
        <>
            <SectionLabel>{t('Model')}</SectionLabel>
            <SectionDescription>
                {t('The model the sidebar uses. Every model in a provider\'s catalogue is listed; the picker in the composer changes the same setting.')}
            </SectionDescription>
            <SettingsGroup>
                <div className="display-flex flex-col gap-2 p-3">
                    <select
                        id="alphain-model"
                        value={currentValue}
                        onChange={(e) => applyModel(e.target.value)}
                        className="p-1 m-0 preference-input text-sm"
                        aria-label={t('Model')}
                    >
                        <option value="">{t('Choose a model…')}</option>
                        {!showsCurrent && (
                            <option value={currentValue}>{t('{provider} · {model} (stored)', { provider, model })}</option>
                        )}
                        {choices.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                                {choice.label}
                            </option>
                        ))}
                    </select>
                    {choices.length === 0 && (
                        <Note>
                            {t('No models are listed because no provider is configured yet. Add one above and its catalogue appears here.')}
                        </Note>
                    )}
                </div>
            </SettingsGroup>
        </>
    );
};
