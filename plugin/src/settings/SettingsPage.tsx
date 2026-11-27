/**
 * The model settings as AlphainZ lays them out, in AlphainO's settings tab:
 * the provider cards, the model, note search, the limits per question, custom
 * instructions and the conversation view — the shared components from
 * @beaver/agent-ui/settings, with AlphainO's settings behind them.
 */
import React, { useEffect, useMemo, useState } from 'react';
import ConversationViewSection from '@beaver/agent-ui/settings/ConversationViewSection';
import CustomInstructionsSection from '@beaver/agent-ui/settings/CustomInstructionsSection';
import ProviderCards, { type OpenCardRequest } from '@beaver/agent-ui/settings/ProviderCards';
import RunLimitsSection, { type LimitPref } from '@beaver/agent-ui/settings/RunLimitsSection';
import { SectionLabel } from '@beaver/agent-ui/settings/SettingsElements';
import { SettingsHostProvider } from '@beaver/agent-ui/settings/host';
import { t } from '../i18n';
import { explainPrompt } from '../agent/explain';
import { ModelChoiceSection } from './ModelChoiceSection';
import { NoteSearchSection, type NoteSearchPlugin } from './NoteSearchSection';
import { obsidianSettingsHost } from './obsidianHost';

/**
 * The limits AlphainO's runs apply. Library searches and literature lookups
 * count AlphainZ's own search tools; AlphainO reaches the library through
 * AlphainZ's server, one call at a time.
 */
const RUN_LIMITS: readonly LimitPref[] = ['maxOutputTokens', 'maxModelRequests'];

export const SettingsPage: React.FC<{ plugin: NoteSearchPlugin }> = ({ plugin }) => {
    const host = useMemo(() => obsidianSettingsHost(plugin), [plugin]);
    // Every settings change, here or elsewhere (the model menu, a key, the
    // note index's health), re-reads what the page shows.
    const [version, setVersion] = useState(0);
    useEffect(() => plugin.onSettingsChange(() => setVersion((n) => n + 1)), [plugin]);
    const [cardRequest, setCardRequest] = useState<OpenCardRequest | null>(null);
    const [railOn, setRailOn] = useState(() => plugin.prefs.get('conversationRail') !== false);
    // The question "Explain" asks, shown as it will be sent (the default when none is set).
    const [explain, setExplain] = useState(() => explainPrompt(plugin.prefs));

    return (
        <SettingsHostProvider host={host} modelsVersion={version}>
            <div className="display-flex flex-col alphaino-settings-page" data-testid="alphaino-settings">
                {/* Each section in its own block, so the page can set them apart (styles/alphaino.css). */}
                <section className="alphaino-settings-section">
                    <ProviderCards openRequest={cardRequest} />
                </section>
                <section className="alphaino-settings-section">
                    <ModelChoiceSection plugin={plugin} />
                </section>
                <section className="alphaino-settings-section">
                    <NoteSearchSection plugin={plugin} onAddKey={(vendorId) => setCardRequest({ vendorId, nonce: Date.now() })} />
                </section>
                <section className="alphaino-settings-section">
                    <RunLimitsSection limits={RUN_LIMITS} />
                </section>
                <section className="alphaino-settings-section">
                    <CustomInstructionsSection>
                        {/* AlphainZ's "Reader Explain Prompt", for text selected in a note. */}
                        <SectionLabel>{t('Explain Prompt')}</SectionLabel>
                        <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                            {t('The prompt sent when you choose "Explain" on text selected in a note or a PDF. Empty uses the default.')}
                        </div>
                        <div className="custom-prompt-card" style={{ cursor: 'default' }}>
                            <textarea
                                value={explain}
                                onChange={(event) => {
                                    setExplain(event.target.value);
                                    plugin.prefs.set('explainPrompt', event.target.value);
                                }}
                                onBlur={() => {
                                    // Emptied: show the default again, which is what will be sent.
                                    if (!explain.trim()) setExplain(explainPrompt(plugin.prefs));
                                }}
                                placeholder={t('Explain the selected passage in plain language...')}
                                aria-label={t('Explain prompt')}
                                rows={4}
                                className="chat-input custom-prompt-edit-textarea text-base"
                                style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                                maxLength={1500}
                            />
                        </div>
                    </CustomInstructionsSection>
                </section>
                <section className="alphaino-settings-section">
                    <ConversationViewSection
                        railOn={railOn}
                        onRailChange={(on) => {
                            setRailOn(on);
                            plugin.prefs.set('conversationRail', on);
                        }}
                        description={t('One tick per question at the right edge of the chat, and one per comment thread in the comments view. Point at a tick to preview it, click it to jump there; the wheel, trackpad and keys still scroll. Off brings the scroll bars back.')}
                    />
                </section>
            </div>
        </SettingsHostProvider>
    );
};
