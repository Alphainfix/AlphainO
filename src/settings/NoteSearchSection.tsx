/**
 * Settings → Note search: the embedding provider that lets the chat find notes
 * by meaning, laid out as AlphainZ's "Topic and full-text search" — the same
 * choice of provider, Test, Google's own key, the line that says what is in
 * the way and the Ollama guide — and, where AlphainZ shows its PDF indexes,
 * the note index's state and the folders note search leaves out.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TFolder } from 'obsidian';
import { EMBEDDING_PRESETS, type EmbeddingPresetId } from '@beaver/agent-llm/embeddings';
import { clearEmbeddingHealth, readEmbeddingHealth } from '@beaver/agent-llm/embeddingHealth';
import { verifyEmbeddingProvider } from '@beaver/agent-llm/verifyKey';
import { VENDORS, type KeyPrefName, type Vendor } from '@beaver/agent-llm/vendors';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import SearchMenu, { type MenuPosition, type SearchMenuItem } from '@beaver/agent-ui/primitives/SearchMenu';
import {
    AlertIcon,
    ArrowRightIcon,
    FolderDetailIcon,
    Icon,
    PlusSignIcon,
    Spinner,
    TickIcon,
    UndoIcon,
} from '@beaver/agent-ui/icons';
import { OllamaGuide } from '@beaver/agent-ui/settings/OllamaGuide';
import { ProgressBar } from '@beaver/agent-ui/settings/ProgressBar';
import { SectionDescription, SectionLabel, SettingsGroup } from '@beaver/agent-ui/settings/SettingsElements';
import { useModelsVersion, useSettingsHost, whenConfirmed } from '@beaver/agent-ui/settings/host';
import { ollamaApiBaseUrl } from '../agent/provider';
import type { IndexStatus } from '../search/types';
import type { ImageIndexStatus } from '../search/imageIndex';
import { t } from '../i18n';
import {
    currentEmbeddingModelId,
    embeddingKeyFor,
    embeddingProviderProblem,
    excludedFolders,
    failureTimeText,
    semanticSearchState,
    setExcludedFolders,
} from './embedding';
import { Note } from './ModelChoiceSection';
import { ollamaBaseUrl, settingsFetch, type SettingsPlugin } from './obsidianHost';
import { onOllamaStatus } from './ollama';

/** The part of the note index the settings show and drive. */
export interface NoteIndexControls {
    status(): IndexStatus;
    onStatusChange(listener: (status: IndexStatus) => void): () => void;
    rebuild(): Promise<void>;
    retry(): void;
}

/** The part of the picture index the settings show and drive. */
export interface ImageIndexControls {
    status(): ImageIndexStatus;
    onStatusChange(listener: (status: ImageIndexStatus) => void): () => void;
    rebuild(): Promise<void>;
    retry(): void;
}

export interface NoteSearchPlugin extends SettingsPlugin {
    noteIndex: NoteIndexControls | null;
    imageIndex?: ImageIndexControls | null;
}

/** AlphainZ's choices, with the key each one uses. */
export const EMBEDDING_OPTIONS: Array<{ id: '' | EmbeddingPresetId; label: string; keyPref?: KeyPrefName }> = [
    { id: '', label: 'Off — keyword search only' },
    { id: 'openai', label: 'OpenAI', keyPref: 'llmKeyOpenai' },
    { id: 'google', label: 'Google Gemini · online', keyPref: 'llmKeyGoogle' },
    { id: 'ollama', label: 'Ollama · EmbeddingGemma 2, on this computer' },
];

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';
interface TestState {
    status: TestStatus;
    message?: string;
}

const TEST_BUTTON = {
    idle: { text: 'Test', icon: ArrowRightIcon },
    testing: { text: 'Test', icon: Spinner },
    ok: { text: 'Works', icon: TickIcon },
    error: { text: 'Failed', icon: AlertIcon },
} as const;

const TestResult: React.FC<{ state: TestState }> = ({ state }) =>
    state.message ? (
        <span
            className={`text-sm ${state.status === 'error' ? 'font-color-error' : 'font-color-secondary'}`}
            role={state.status === 'error' ? 'alert' : undefined}
        >
            {state.message}
        </span>
    ) : null;

/** The vendor whose key an embedding option uses, for "Add the key". */
const vendorForKey = (keyPref: KeyPrefName | undefined): Vendor | undefined =>
    keyPref ? VENDORS.find((vendor) => vendor.keyPref === keyPref) : undefined;

export const NoteSearchSection: React.FC<{ plugin: NoteSearchPlugin; onAddKey: (vendorId: string) => void }> = ({ plugin, onAddKey }) => {
    const host = useSettingsHost();
    const { prefs } = plugin;
    useModelsVersion();
    const [embeddingProvider, setEmbeddingProvider] = useState(() => prefs.string('embeddingProvider'));
    const [embeddingTest, setEmbeddingTest] = useState<TestState>({ status: 'idle' });
    const [googleEmbeddingKey, setGoogleEmbeddingKey] = useState(() => prefs.string('embeddingKeyGoogle'));

    // Google's own key is kept when the field is left (and when the page
    // closes), not on every keystroke: the note index rebuilds its embedder
    // whenever the key it uses changes.
    const typedKeyRef = useRef<string | null>(null);
    const commitGoogleKey = () => {
        const typed = typedKeyRef.current;
        typedKeyRef.current = null;
        if (typed !== null && typed !== prefs.string('embeddingKeyGoogle')) prefs.set('embeddingKeyGoogle', typed);
    };
    useEffect(() => () => commitGoogleKey(), []);

    // Whether the chosen provider can be used changes with the keys (every
    // settings change re-renders this page) and with what Ollama has.
    const [, bumpOllamaReads] = useState(0);
    useEffect(() => onOllamaStatus(() => bumpOllamaReads((n) => n + 1)), []);
    const semantic = semanticSearchState(plugin);
    const embeddingReady = semantic.status === 'ready';
    const embeddingHealth = embeddingReady ? readEmbeddingHealth(currentEmbeddingModelId(plugin)) : null;

    const runEmbeddingTest = async () => {
        if (!embeddingProvider) return;
        commitGoogleKey();
        const option = EMBEDDING_OPTIONS.find((o) => o.id === embeddingProvider);
        const id = embeddingProvider as EmbeddingPresetId;
        const key = embeddingKeyFor(plugin, id);
        if (option?.keyPref && !key) {
            // Nothing to send: the key lives on the provider's card above.
            setEmbeddingTest({
                status: 'error',
                message: id === 'google'
                    ? t('This computer has no Google key yet. Add it on the Google Gemini card above, or below.')
                    : t('This computer has no {label} key yet. Add it under Providers, above.', { label: t(option.label) }),
            });
            return;
        }
        setEmbeddingTest({ status: 'testing' });
        const result = await verifyEmbeddingProvider(
            id,
            key,
            settingsFetch,
            // Ollama is tested at the address on its card, where the index sends its requests.
            id === 'ollama' ? { baseUrl: ollamaApiBaseUrl(prefs) } : {},
        );
        setEmbeddingTest({ status: result.ok ? 'ok' : 'error', message: result.message });
        // A test that went through is a request that worked: whatever failed
        // before is no longer the state of things, and a paused index can go on.
        if (result.ok) {
            clearEmbeddingHealth();
            if (plugin.noteIndex?.status().state === 'paused') plugin.noteIndex.retry();
        }
    };

    const embeddingButton = TEST_BUTTON[embeddingTest.status];
    const embeddingProblem = embeddingProvider ? embeddingProviderProblem(semantic) : null;
    const keyVendor = semantic.status === 'needs_key'
        ? vendorForKey(EMBEDDING_OPTIONS.find((o) => o.id === semantic.provider)?.keyPref)
        : undefined;
    const optionLabel = (option: (typeof EMBEDDING_OPTIONS)[number]) =>
        option.id && option.keyPref && !embeddingKeyFor(plugin, option.id)
            ? t('{label} — no key on this computer yet', { label: t(option.label) })
            : t(option.label);

    return (
        <>
            <SectionLabel>{t('Note search')}</SectionLabel>
            <SectionDescription>
                {t('Finding notes by what they are about, not only by the words in them, needs an embedding provider. Leave it off and the chat searches by keyword, and is told so, instead of reading an empty result as proof your notes hold nothing on the subject.')}
            </SectionDescription>

            <SettingsGroup>
                <div className="display-flex flex-col gap-2 p-3">
                    {/* What the choice is and where its key goes, so the setting can be found without knowing the term. */}
                    <label htmlFor="alphain-embedding-provider" className="text-base font-semibold font-color-primary">
                        {t('Embedding provider (search by meaning)')}
                    </label>
                    <div className="text-sm font-color-secondary">
                        {t('Pick one to search notes by meaning. Its key: OpenAI uses the key in its card under Providers above; Google uses its card’s key, or a key for embeddings only that you can paste below once Google is picked; Ollama runs on this computer and needs no key.')}
                    </div>
                    <select
                        id="alphain-embedding-provider"
                        value={embeddingProvider}
                        onChange={(e) => {
                            setEmbeddingProvider(e.target.value);
                            host.setPref('embeddingProvider', e.target.value);
                            setEmbeddingTest({ status: 'idle' });
                        }}
                        className="p-1 m-0 preference-input text-sm"
                        aria-label={t('Embedding provider')}
                    >
                        {EMBEDDING_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                                {optionLabel(option)}
                            </option>
                        ))}
                    </select>

                    {embeddingProblem && (
                        <div className="display-flex flex-row items-center gap-2 flex-wrap" role="status" data-testid="embedding-problem">
                            <span className="text-sm font-color-yellow">
                                {embeddingProblem}{' '}{t('Until then notes are searched by keyword only. Embedding starts by itself once that is fixed.')}
                            </span>
                            {keyVendor && (
                                <Button
                                    variant="outline"
                                    style={{ padding: '3px 6px' }}
                                    onClick={() => onAddKey(keyVendor.id)}
                                >
                                    {t('Add the {label} key', { label: keyVendor.label })}
                                </Button>
                            )}
                        </div>
                    )}

                    {/* Configured, but the last request failed: said here until one succeeds. */}
                    {embeddingReady && embeddingHealth && (
                        <div className="display-flex flex-row items-start gap-1" role="status" data-testid="embedding-health">
                            <Icon icon={AlertIcon} className="scale-90 mt-015 font-color-yellow flex-shrink-0" />
                            <span className="text-sm font-color-yellow">
                                {t('Not working since {time}: {reason}', { time: failureTimeText(embeddingHealth.failedAt), reason: embeddingHealth.reason })}{' '}
                                {t('Note search falls back to keywords meanwhile. This clears by itself once a request goes through — Test checks now.')}
                            </span>
                        </div>
                    )}

                    {embeddingProvider === 'google' && (
                        <div className="display-flex flex-col gap-1 mt-2">
                            <label htmlFor="alphain-key-embedding-google" className="text-sm font-color-primary">
                                {t('Key for embeddings (optional)')}
                            </label>
                            <input
                                id="alphain-key-embedding-google"
                                type="password"
                                value={googleEmbeddingKey}
                                onChange={(e) => {
                                    setGoogleEmbeddingKey(e.target.value);
                                    typedKeyRef.current = e.target.value.trim();
                                    setEmbeddingTest({ status: 'idle' });
                                }}
                                onBlur={commitGoogleKey}
                                placeholder={plugin.apiKey('google') ? t('Empty: the Google Gemini card’s key is used') : t('Paste a Google AI Studio key')}
                                className="p-1 m-0 preference-input text-sm border-quinary"
                            />
                            <Note>
                                {googleEmbeddingKey.trim()
                                    ? t('Embeddings use this key; chat keeps the Google Gemini card’s.')
                                    : t('Embeddings use the Google Gemini card’s key. A key here is used for note search only, and wins over the card’s.')}
                                {' '}{t('Gemini Embedding 2. A key from a project with no billing is free but allows about 100 texts a minute and 1000 a day, and Google may use what it is sent to improve its products; when Google reports the free tier, indexing keeps a fifth of each for your searches. A paid key costs about $1 per 20,000 passages.')}
                            </Note>
                        </div>
                    )}

                    {embeddingProvider && (
                        <>
                            {semantic.status !== 'needs_key' && (
                                <div className="display-flex flex-row items-center gap-2">
                                    <Button
                                        variant="outline"
                                        style={{ padding: '3px 6px' }}
                                        rightIcon={embeddingButton.icon}
                                        onClick={() => void runEmbeddingTest()}
                                        disabled={embeddingTest.status === 'testing'}
                                    >
                                        {t(embeddingButton.text)}
                                    </Button>
                                    <TestResult state={embeddingTest} />
                                </div>
                            )}
                            <Note>
                                {t('Only one model’s vectors are kept: switching to another model embeds every note again.')}
                            </Note>
                            {embeddingProvider === 'ollama' && (
                                <OllamaGuide
                                    base={ollamaBaseUrl(prefs)}
                                    showEmbedding
                                    compact
                                    onModelsChanged={() => setEmbeddingTest({ status: 'idle' })}
                                />
                            )}
                        </>
                    )}

                    {plugin.noteIndex && <NoteIndexBlock index={plugin.noteIndex} embeddingReady={embeddingReady} />}
                    {plugin.imageIndex && (
                        <PictureIndexBlock
                            index={plugin.imageIndex}
                            provider={embeddingProvider && embeddingProvider in EMBEDDING_PRESETS ? EMBEDDING_PRESETS[embeddingProvider as EmbeddingPresetId].label : ''}
                        />
                    )}
                    <ExcludedFoldersBlock plugin={plugin} />
                </div>
            </SettingsGroup>
        </>
    );
};

// ---------------------------------------------------------------------------
// The note index: how far it got, and Rebuild / Retry
// ---------------------------------------------------------------------------

const NoteIndexBlock: React.FC<{ index: NoteIndexControls; embeddingReady: boolean }> = ({ index, embeddingReady }) => {
    const host = useSettingsHost();
    const [status, setStatus] = useState<IndexStatus>(() => index.status());
    useEffect(() => {
        setStatus(index.status());
        return index.onStatusChange(setStatus);
    }, [index]);
    // The time a paused index tries again moves on as the clock does.
    const [, tick] = useState(0);
    useEffect(() => {
        if (status.state !== 'paused' || !status.retryAt) return;
        const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
        return () => window.clearInterval(timer);
    }, [status.state, status.retryAt]);

    const percent = status.notesTotal > 0 ? Math.round(Math.min(100, (status.notesIndexed / status.notesTotal) * 100)) : 0;
    const coverage = status.state === 'off'
        ? t('The index starts once the vault has loaded.')
        : status.notesTotal === 0
            ? t('No notes to index yet.')
            : t('{indexed} of {total} notes indexed · {chunks} passages.', {
                indexed: status.notesIndexed.toLocaleString(),
                total: status.notesTotal.toLocaleString(),
                chunks: status.chunks.toLocaleString(),
            });

    const rebuild = () => {
        whenConfirmed(host.confirm(
            t('Rebuild the note index?'),
            t('Every note is read again and, with an embedding provider, embedded again. For a cloud model that uses its quota.'),
            t('Rebuild'),
        ), () => void index.rebuild());
    };

    return (
        <div className="display-flex flex-col gap-2 mt-2 pt-2 border-top-quinary" data-testid="note-index">
            <div className="text-base font-semibold font-color-primary">{t('Your notes')}</div>
            <div className="text-sm font-color-secondary" data-testid="note-index-coverage">
                {coverage}
                {!embeddingReady && status.notesTotal > 0 ? ' ' + t('Searched by keyword only until an embedding provider can be used.') : ''}
            </div>
            {status.state === 'indexing' && (
                <>
                    <ProgressBar progress={percent} />
                    <div className="text-sm font-color-tertiary">
                        {t('Indexing · {pending} notes to go.', { pending: status.pending.toLocaleString() })}
                    </div>
                </>
            )}
            {status.state === 'paused' && (
                <span className="text-sm font-color-yellow" role="status">
                    {status.lastError ?? t('Paused.')}
                    {status.retryAt ? ' ' + t('It tries again at {time}.', { time: failureTimeText(status.retryAt) }) : ''}
                </span>
            )}
            {status.state === 'error' && status.lastError && (
                <span className="text-sm font-color-error" role="alert">
                    {status.lastError}
                </span>
            )}
            <div className="display-flex flex-row items-center gap-2 flex-wrap">
                {status.state === 'paused' && (
                    <Button variant="outline" style={{ padding: '3px 6px' }} onClick={() => index.retry()}>
                        {t('Retry now')}
                    </Button>
                )}
                <Button
                    variant="outline"
                    style={{ padding: '3px 6px' }}
                    onClick={rebuild}
                    disabled={status.state === 'off'}
                >
                    {t('Rebuild the index')}
                </Button>
            </div>
            <Note>
                {t('Notes are indexed in the background as they change, kept on this computer, and read again only when they change.')}
            </Note>
        </div>
    );
};

// ---------------------------------------------------------------------------
// The vault's pictures: found by what they show
// ---------------------------------------------------------------------------

const PictureIndexBlock: React.FC<{ index: ImageIndexControls; provider: string }> = ({ index, provider }) => {
    const host = useSettingsHost();
    const [on, setOn] = useState(() => host.getPref('vaultImageIndex') === true);
    const [status, setStatus] = useState<ImageIndexStatus>(() => index.status());
    useEffect(() => {
        setStatus(index.status());
        return index.onStatusChange(setStatus);
    }, [index]);
    const [, tick] = useState(0);
    useEffect(() => {
        if (status.state !== 'paused' || !status.retryAt) return;
        const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
        return () => window.clearInterval(timer);
    }, [status.state, status.retryAt]);

    const readable = Math.max(0, status.imagesTotal - status.skipped);
    const percent = readable > 0 ? Math.round(Math.min(100, (status.imagesIndexed / readable) * 100)) : 0;
    const coverage = status.offReason === 'no-model'
        ? t('Choose an embedding provider above first.')
        : status.offReason === 'text-only'
            ? t('The chosen embedding model reads text only. Pictures need Google Gemini or Ollama (EmbeddingGemma 2).')
            : status.imagesTotal === 0
                ? t('No pictures in the vault yet.')
                : t('{indexed} of {total} pictures indexed.', { indexed: status.imagesIndexed.toLocaleString(), total: readable.toLocaleString() });
    const rebuild = () => {
        whenConfirmed(host.confirm(
            t('Rebuild the picture index?'),
            t('Every picture is read and embedded again. For a cloud model that uses its quota.'),
            t('Rebuild'),
        ), () => void index.rebuild());
    };

    return (
        <div className="display-flex flex-col gap-2 mt-2 pt-2 border-top-quinary" data-testid="picture-index">
            <label className="display-flex flex-row items-center gap-2 cursor-pointer">
                <input
                    type="checkbox"
                    checked={on}
                    onChange={(event) => {
                        setOn(event.target.checked);
                        host.setPref('vaultImageIndex', event.target.checked);
                    }}
                />
                <span className="text-base font-semibold font-color-primary">{t('Pictures: find them by what they show')}</span>
            </label>
            <Note>
                {t('Screenshots, photos and diagrams in the vault are indexed as images, so the chat can find one from a description (“the chart of monthly costs”, “a photo of the whiteboard”) and show it in an answer.')}
                {' '}
                {provider
                    ? t('Each picture is shrunk and sent to {provider} once; pictures in excluded folders are not.', { provider })
                    : t('Each picture is shrunk and sent to the embedding provider once; pictures in excluded folders are not.')}
                {' '}
                {t('Needs Google Gemini or Ollama (EmbeddingGemma 2). Pictures are indexed after the notes.')}
            </Note>
            {on && (
                <>
                    <div className="text-sm font-color-secondary" data-testid="picture-index-coverage">
                        {coverage}
                        {status.skipped > 0
                            ? ' ' + t('{count} left out: a format this app cannot open (such as HEIC), too big, or refused by the model.', { count: status.skipped.toLocaleString() })
                            : ''}
                        {status.retrying > 0
                            ? ' ' + t('{count} could not be read just now (iCloud may still be downloading them) and are tried again later.', { count: status.retrying.toLocaleString() })
                            : ''}
                    </div>
                    {status.state === 'indexing' && status.pending > 0 && (
                        <>
                            <ProgressBar progress={percent} />
                            <div className="text-sm font-color-tertiary">
                                {t('Indexing · {pending} pictures to go.', { pending: status.pending.toLocaleString() })}
                            </div>
                        </>
                    )}
                    {status.state === 'paused' && (
                        <span className="text-sm font-color-yellow" role="status">
                            {status.lastError ?? t('Paused.')}
                            {status.retryAt ? ' ' + t('It tries again at {time}.', { time: failureTimeText(status.retryAt) }) : ''}
                        </span>
                    )}
                    {status.state === 'error' && status.lastError && (
                        <span className="text-sm font-color-error" role="alert">
                            {status.lastError}
                        </span>
                    )}
                    {!status.offReason && (
                        <div className="display-flex flex-row items-center gap-2 flex-wrap">
                            {status.state === 'paused' && (
                                <Button variant="outline" style={{ padding: '3px 6px' }} onClick={() => index.retry()}>
                                    {t('Retry now')}
                                </Button>
                            )}
                            <Button variant="outline" style={{ padding: '3px 6px' }} onClick={rebuild} disabled={status.state === 'off'}>
                                {t('Rebuild the picture index')}
                            </Button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Folders left out of note search (AlphainZ's excluded libraries, for a vault)
// ---------------------------------------------------------------------------

/** Every folder in the vault, by path, without the root. */
function vaultFolders(plugin: SettingsPlugin): string[] {
    return plugin.app.vault
        .getAllLoadedFiles()
        .filter((file): file is TFolder => file instanceof TFolder && file.path !== '/' && file.path !== '')
        .map((folder) => folder.path)
        .sort((a, b) => a.localeCompare(b));
}

const ExcludedFoldersBlock: React.FC<{ plugin: SettingsPlugin }> = ({ plugin }) => {
    const { prefs } = plugin;
    useModelsVersion();
    const folders = excludedFolders(prefs);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [searchQuery, setSearchQuery] = useState('');
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    const notesIn = (folder: string) =>
        plugin.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${folder}/`)).length;

    const available = useMemo(() => {
        if (!isMenuOpen) return [];
        const query = searchQuery.trim().toLowerCase();
        return vaultFolders(plugin)
            // A folder inside an excluded one is excluded already.
            .filter((path) => !folders.some((folder) => path === folder || path.startsWith(`${folder}/`)))
            .filter((path) => !query || path.toLowerCase().includes(query))
            .slice(0, 200);
    }, [isMenuOpen, searchQuery, folders.join('\n')]);

    const exclude = (folder: string) => {
        setExcludedFolders(prefs, [...folders.filter((path) => !path.startsWith(`${folder}/`)), folder]);
        setIsMenuOpen(false);
    };
    const include = (folder: string) => setExcludedFolders(prefs, folders.filter((path) => path !== folder));

    const menuItems: SearchMenuItem[] = available.map((path) => ({
        label: path,
        onClick: () => exclude(path),
        customContent: (
            <div className="display-flex flex-row gap-2 items-center min-w-0 w-full">
                <Icon icon={FolderDetailIcon} className="scale-90 font-color-secondary" />
                <span className="truncate font-color-primary">{path}</span>
            </div>
        ),
    }));

    return (
        <div className="display-flex flex-col gap-2 mt-2 pt-2 border-top-quinary" data-testid="excluded-folders">
            <div className="display-flex flex-row items-center justify-between gap-3">
                <div className="text-base font-semibold font-color-primary">{t('Excluded folders')}</div>
                <button
                    ref={buttonRef}
                    type="button"
                    className="variant-outline"
                    style={{ marginRight: '1px', padding: '4px 6px' }}
                    onClick={() => {
                        const rect = buttonRef.current?.getBoundingClientRect();
                        if (!rect) return;
                        setSearchQuery('');
                        setMenuPosition({ x: rect.right, y: rect.top });
                        setIsMenuOpen(true);
                    }}
                    aria-label={t('Exclude a folder')}
                >
                    <Icon icon={PlusSignIcon} className="scale-11" />
                    <span>{t('Exclude a folder…')}</span>
                </button>
            </div>
            <div className="text-sm font-color-secondary">
                {t('Notes in these folders are left out of note search and of the note lists the chat sees.')}
            </div>
            <div className="display-flex flex-col rounded-md border-popup">
                {folders.length === 0 ? (
                    <div className="p-2 text-base font-color-secondary">{t('No folders excluded.')}</div>
                ) : (
                    folders.map((folder, index) => (
                        <div
                            key={folder}
                            className={`display-flex flex-row items-center justify-between p-2 ${index > 0 ? 'border-top-quinary' : ''}`}
                        >
                            <div className="display-flex flex-row items-start gap-2 min-w-0">
                                <Icon icon={FolderDetailIcon} className="scale-90 font-color-secondary mt-015" />
                                <div className="display-flex flex-col min-w-0 gap-1">
                                    <div className="font-color-primary truncate">{folder}</div>
                                    <div className="text-sm font-color-tertiary">
                                        {t('{count} notes', { count: notesIn(folder).toLocaleString() })}
                                    </div>
                                </div>
                            </div>
                            <IconButton
                                onClick={() => include(folder)}
                                variant="ghost-secondary"
                                ariaLabel={t('Include {folder} again', { folder })}
                                title={t('Include {folder} again', { folder })}
                                icon={UndoIcon}
                            />
                        </div>
                    ))
                )}
            </div>
            <SearchMenu
                menuItems={menuItems}
                isOpen={isMenuOpen}
                onClose={() => setIsMenuOpen(false)}
                position={menuPosition}
                useFixedPosition={true}
                verticalPosition="below"
                positionAdjustment={{ y: 18 }}
                width="280px"
                maxHeight="260px"
                onSearch={() => {}}
                noResultsText={t('No folders found')}
                placeholder={t('Search folders')}
                closeOnSelect={true}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                showSearchInput={true}
            />
        </div>
    );
};
