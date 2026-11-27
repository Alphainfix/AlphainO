/**
 * The composer's model button: the model that will answer, and a menu to
 * change it or its thinking — the same two choices, lists, names and order as
 * AlphainZ's picker, drawn with Obsidian's own menu.
 *
 * Like AlphainZ, one menu shows one view at a time: the two choices, then the
 * list behind each. A flat menu would show a dozen models and the thinking
 * tiers at once.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Menu } from 'obsidian';
import { EFFORT_LABELS, displayNameFor, groupByVendor, rowLabel } from '@beaver/agent-llm/modelChoices';
import { THINKING_TIER_NAMES } from '@beaver/agent-llm/thinkingTiers';
import type AlphainOPlugin from '../main';
import { availableModels, chooseModel, selectedModel, shownEffort, thinkingTiersFor } from '../agent/models';
import { t } from '../i18n';
import { Icon } from './Icon';

type View = 'root' | 'model' | 'thinking';

export function ModelButton({ plugin, disabled }: { plugin: AlphainOPlugin; disabled?: boolean }) {
    const [, rerender] = useState(0);
    const buttonRef = useRef<HTMLButtonElement>(null);
    useEffect(() => plugin.onSettingsChange(() => rerender((n) => n + 1)), [plugin]);

    const selected = selectedModel(plugin);
    const label = selected ? displayNameFor(selected) : t('None selected');

    const show = (view: View) => {
        const button = buttonRef.current;
        if (!button) return;
        // A menu item's click closes its menu; the next view opens after that.
        const next = (v: View) => () => window.setTimeout(() => show(v), 0);
        const models = availableModels(plugin);
        const current = selectedModel(plugin);
        const tiers = thinkingTiersFor(current);
        const effort = shownEffort(plugin.prefs, current);
        const menu = new Menu();

        if (view === 'root') {
            menu.addItem((item) =>
                item
                    .setTitle(`${t('Model')} · ${current ? rowLabel(current) : t('None selected')}`)
                    .setIcon('cpu')
                    .onClick(next('model')),
            );
            // Next to the model because it is a per-question choice; hidden
            // for a model that takes no effort, where it would be refused.
            if (tiers.length > 0 && effort) {
                menu.addItem((item) =>
                    item
                        .setTitle(`${t('Thinking')} · ${t(THINKING_TIER_NAMES[effort] ?? effort)}`)
                        .setIcon('brain')
                        .onClick(next('thinking')),
                );
            }
            menu.addSeparator();
            menu.addItem((item) => item.setTitle(t('Manage models…')).setIcon('settings').onClick(() => plugin.openSettings()));
        } else if (view === 'model') {
            menu.addItem((item) => item.setTitle(`‹ ${t('Model')}`).onClick(next('root')));
            if (models.length === 0) {
                menu.addItem((item) =>
                    item.setTitle(t('No models yet: add a provider’s key in settings')).onClick(() => plugin.openSettings()),
                );
            }
            for (const group of groupByVendor(models)) {
                menu.addItem((item) => item.setTitle(t(group.vendor)).setIsLabel(true));
                for (const model of group.models) {
                    menu.addItem((item) =>
                        item
                            .setTitle(rowLabel(model))
                            .setChecked(current?.id === model.id)
                            .onClick(() => chooseModel(model)),
                    );
                }
            }
        } else {
            menu.addItem((item) => item.setTitle(`‹ ${t('Thinking')}`).onClick(next('root')));
            for (const tier of tiers) {
                menu.addItem((item) =>
                    item
                        .setTitle(t(EFFORT_LABELS[tier] ?? tier))
                        .setChecked(effort === tier)
                        .onClick(() => plugin.prefs.set('reasoningEffort', tier)),
                );
            }
        }

        const rect = button.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.top, width: rect.width }, button.ownerDocument);
    };

    return (
        <button
            ref={buttonRef}
            className="alphaino-model-button clickable-icon"
            disabled={disabled}
            aria-label={t('AI model: {name}. Choose AI model', { name: label })}
            onClick={() => show('root')}
        >
            <Icon name="brain" />
            <span className="alphaino-model-name">{label}</span>
            <Icon name="chevron-down" />
        </button>
    );
}
