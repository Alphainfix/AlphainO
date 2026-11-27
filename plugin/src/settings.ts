/**
 * AlphainO's settings, kept in the plugin's data.json inside the vault.
 *
 * `prefs` holds the model layer's settings under the keys @beaver/agent-llm
 * and AlphainZ use (`llmProvider`, `llmModel`, `reasoningEffort`, …), with
 * AlphainZ's defaults, so the shared code reads them the same way in both
 * clients. API keys are never stored here: the vault syncs, so a key lives in
 * Obsidian's secret storage on each computer and this file records only the
 * secret's name (`keySecrets`). The settings page writes keys as AlphainZ
 * does, under AlphainZ's names (`llmKeyDeepseek`, `embeddingKeyGoogle`, the
 * `apiKey` of a hand-added endpoint); {@link PrefStore} sends each one to its
 * secret instead.
 */
import { VENDORS } from '@beaver/agent-llm/vendors';
import { customProviderId } from '@beaver/agent-llm/customEndpoints';
import { DEFAULT_ZOTERO_PORT } from './zotero/client';

export interface AlphainOSettings {
    /** The model layer's settings, by the keys it reads. */
    prefs: Record<string, unknown>;
    /**
     * The id of the secret that holds each key: by provider id (`deepseek`,
     * `custom:<endpoint id>`), or by the setting's own name for a key that is
     * not a provider's (`embeddingKeyGoogle`).
     */
    keySecrets: Partial<Record<string, string>>;
    /**
     * AlphainO's own folder in the vault (conversations, comments). Empty
     * until the first run decides it: `Agent/.alphaino` when the vault has an
     * `Agent` folder, `.alphaino` otherwise.
     */
    dataFolder: string;
    /**
     * Whether the chat has been put in the right sidebar once. It is placed
     * there on the first run so its tab (the panda) shows next to Backlinks
     * and Outline; a user who closes it is not overruled later.
     */
    chatPlaced: boolean;
    /**
     * Whether the chat may search the Zotero library through AlphainZ's MCP
     * server. It costs nothing while Zotero is closed: the tools are then
     * simply not offered.
     */
    zoteroEnabled: boolean;
    /** The port of Zotero's local HTTP server, where AlphainZ serves its MCP endpoint. */
    zoteroPort: number;
}

/** AlphainZ's defaults for the keys the model layer reads (addon/prefs.js). */
export const PREF_DEFAULTS: Readonly<Record<string, unknown>> = {
    llmProvider: '',
    llmModel: '',
    reasoningEffort: 'low',
    maxOutputTokens: 0,
    maxModelRequests: 24,
    maxLibrarySearches: 20,
    maxLiteratureLookups: 20,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    customEndpoints: '[]',
    providerOverrides: '{}',
    visionProbeCache: '{}',
    embeddingHealth: '',
    embeddingQuota: '{}',
    embeddingProvider: '',
    customInstructions: '',
    // Save an answer about a passage as a comment on it without asking (AlphainZ's selectionChatAutoComment).
    selectionChatAutoComment: false,
    // Empty: "Explain" asks the default question (src/agent/explain.ts).
    explainPrompt: '',
    conversationRail: true,
    // Index the vault's pictures too, to find them by what they show (sent to the embedding provider). Off until turned on.
    vaultImageIndex: false,
    // How much of an answer's working steps the chat shows: expanded, collapsed or answer (AlphainZ's key and default).
    streamDisplay: 'collapsed',
};

export const DEFAULT_SETTINGS: AlphainOSettings = {
    prefs: {},
    keySecrets: {},
    dataFolder: '',
    chatPlaced: false,
    zoteroEnabled: true,
    zoteroPort: DEFAULT_ZOTERO_PORT,
};

/** A TCP port number, or null. */
export function validPort(value: unknown): number | null {
    const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** Settings read from disk, with anything missing or malformed replaced by its default. */
export function normalizeSettings(raw: unknown): AlphainOSettings {
    const data = raw && typeof raw === 'object' ? (raw as Partial<AlphainOSettings>) : {};
    const prefs = data.prefs && typeof data.prefs === 'object' ? { ...data.prefs } : {};
    const keySecrets: AlphainOSettings['keySecrets'] = {};
    if (data.keySecrets && typeof data.keySecrets === 'object') {
        for (const [id, secret] of Object.entries(data.keySecrets)) {
            if (typeof secret === 'string' && secret) keySecrets[id] = secret;
        }
    }
    return {
        prefs,
        keySecrets,
        dataFolder: typeof data.dataFolder === 'string' ? data.dataFolder : '',
        chatPlaced: data.chatPlaced === true,
        zoteroEnabled: data.zoteroEnabled !== false,
        zoteroPort: validPort(data.zoteroPort) ?? DEFAULT_ZOTERO_PORT,
    };
}

/** The part of Obsidian's secret storage the settings use. */
export interface SecretStore {
    getSecret(id: string): string | null;
    setSecret(id: string, secret: string): void;
}

/** Settings that hold an API key: AlphainZ's `llmKey…` and `embeddingKey…`. */
const KEY_SETTING = /^(llmKey|embeddingKey)[A-Z]\w*$/;

/** Whether a setting holds an API key, which never goes into data.json. */
export function isKeySetting(key: string): boolean {
    return KEY_SETTING.test(key);
}

/** Secrets AlphainO named itself; it empties them when their key is removed. Others may be shared. */
const OWN_SECRET_PREFIX = 'alphaino-';

/** "OpencodeGo" → "opencode-go": a secret id is lower-case letters, digits and dashes. */
function secretSlug(text: string): string {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** A short, stable hash, so two ids that read alike as secret ids stay apart. */
function shortHash(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

/** The secret a hand-added endpoint's key is kept under when none is named yet. */
export function endpointSecretName(endpointId: string): string {
    const slug = secretSlug(endpointId) || 'endpoint';
    return slug === endpointId ? `${OWN_SECRET_PREFIX}custom-${slug}` : `${OWN_SECRET_PREFIX}custom-${slug}-${shortHash(endpointId)}`;
}

/**
 * Where a key setting is kept: the `keySecrets` entries that name its secret
 * (every provider a vendor's key unlocks, or the setting itself), and the
 * secret it gets when none is named yet.
 */
function keySlot(key: string): { names: string[]; fresh: string } {
    const vendor = VENDORS.find((entry) => entry.keyPref === key);
    if (vendor) return { names: vendor.providers.map((provider) => provider.id), fresh: `${OWN_SECRET_PREFIX}${vendor.id}` };
    return { names: [key], fresh: `${OWN_SECRET_PREFIX}${secretSlug(key)}` };
}

/**
 * The model layer's view of the settings: a key/value store with AlphainZ's
 * defaults underneath. Writes are saved by the plugin.
 *
 * Keys are the exception. A key setting reads from, and writes to, the
 * secret `keySecrets` names (one is named `alphaino-…` on first write), and a
 * hand-added endpoint's key is lifted out of `customEndpoints` the same way
 * and put back when it is read. A secret AlphainO named itself is emptied
 * when its key is removed; a secret the user named (and may use elsewhere) is
 * only let go.
 */
export class PrefStore {
    private secrets: SecretStore | null;

    constructor(
        private readonly settings: () => AlphainOSettings,
        private readonly save: () => void,
        secrets?: SecretStore,
    ) {
        this.secrets = secrets ?? null;
    }

    /** Keep keys in this secret storage (Obsidian's `app.secretStorage`). */
    attachSecrets(secrets: SecretStore): void {
        this.secrets = secrets;
    }

    get(key: string): unknown {
        if (isKeySetting(key)) return this.readKey(key);
        if (key === 'customEndpoints') return this.readEndpoints();
        const prefs = this.settings().prefs;
        return Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : PREF_DEFAULTS[key];
    }

    set(key: string, value: unknown): void {
        if (isKeySetting(key)) this.writeKey(key, typeof value === 'string' ? value : String(value ?? ''));
        else if (key === 'customEndpoints') this.writeEndpoints(typeof value === 'string' ? value : '[]');
        else this.settings().prefs[key] = value;
        this.save();
    }

    clear(key: string): void {
        if (isKeySetting(key)) this.writeKey(key, '');
        else if (key === 'customEndpoints') this.writeEndpoints('[]');
        else delete this.settings().prefs[key];
        this.save();
    }

    /** A string setting, trimmed; '' when unset or not a string. */
    string(key: string): string {
        const value = this.get(key);
        return typeof value === 'string' ? value.trim() : '';
    }

    /**
     * Save after the read that moved a key: a read can happen while a view
     * renders, and saving tells every settings listener at once.
     */
    private saveSoon(): void {
        void Promise.resolve().then(() => this.save());
    }

    private requireSecrets(): SecretStore {
        if (!this.secrets) throw new Error('Obsidian’s secret storage is not available, so the key could not be kept.');
        return this.secrets;
    }

    private secretValue(name: string | undefined): string {
        if (!name || !this.secrets) return '';
        return (this.secrets.getSecret(name) ?? '').trim();
    }

    /** Let go of a secret: emptied when AlphainO named it, left alone when the user did. */
    private release(name: string | undefined): void {
        if (!name || !name.startsWith(OWN_SECRET_PREFIX) || !this.secrets) return;
        try {
            this.secrets.setSecret(name, '');
        } catch {
            // Nothing to empty.
        }
    }

    private readKey(key: string): string {
        const settings = this.settings();
        const inline = settings.prefs[key];
        // A key that reached data.json some other way moves to its secret now.
        if (typeof inline === 'string' && this.secrets) {
            delete settings.prefs[key];
            if (inline.trim()) this.writeKey(key, inline);
            this.saveSoon();
        }
        const { names } = keySlot(key);
        return this.secretValue(names.map((name) => settings.keySecrets[name]).find(Boolean));
    }

    private writeKey(key: string, value: string): void {
        const settings = this.settings();
        const { names, fresh } = keySlot(key);
        const named = names.map((name) => settings.keySecrets[name]).find(Boolean);
        delete settings.prefs[key];
        if (value.trim()) {
            const secret = named ?? fresh;
            this.requireSecrets().setSecret(secret, value);
            for (const name of names) settings.keySecrets[name] = secret;
        } else if (named && named.startsWith(OWN_SECRET_PREFIX)) {
            // Keys are kept per computer while data.json syncs: removing one empties it here only, and the
            // binding stays for the other computers, which keep their own key under the same name.
            this.release(named);
        } else {
            // A secret the user named (and may use elsewhere) is let go, not emptied.
            for (const name of names) delete settings.keySecrets[name];
        }
    }

    /** The stored endpoints, each with its key put back from its secret. */
    private readEndpoints(): string {
        const settings = this.settings();
        const raw = settings.prefs.customEndpoints;
        const stored = typeof raw === 'string' ? raw : (PREF_DEFAULTS.customEndpoints as string);
        let endpoints: unknown;
        try {
            endpoints = JSON.parse(stored);
        } catch {
            return stored;
        }
        if (!Array.isArray(endpoints)) return stored;
        // A key written into data.json some other way moves to its secret now; the others keep theirs.
        if (this.secrets && endpoints.some((endpoint) => typeof endpoint?.apiKey === 'string' && endpoint.apiKey.trim())) {
            const withKeys = endpoints.map((endpoint) =>
                endpoint && typeof endpoint === 'object' && typeof endpoint.id === 'string'
                    ? {
                          ...endpoint,
                          apiKey:
                              (typeof endpoint.apiKey === 'string' && endpoint.apiKey.trim()) ||
                              this.secretValue(settings.keySecrets[customProviderId(endpoint.id)]),
                      }
                    : endpoint,
            );
            this.writeEndpoints(JSON.stringify(withKeys));
            this.saveSoon();
            return this.readEndpoints();
        }
        return JSON.stringify(
            endpoints.map((endpoint) =>
                endpoint && typeof endpoint === 'object' && typeof endpoint.id === 'string'
                    ? { ...endpoint, apiKey: this.secretValue(settings.keySecrets[customProviderId(endpoint.id)]) }
                    : endpoint,
            ),
        );
    }

    /** Store the endpoints without their keys, each key in its endpoint's secret. */
    private writeEndpoints(json: string): void {
        const settings = this.settings();
        let endpoints: unknown;
        try {
            endpoints = JSON.parse(json);
        } catch {
            endpoints = [];
        }
        const list: Array<Record<string, unknown>> = Array.isArray(endpoints)
            ? endpoints.filter((endpoint): endpoint is Record<string, unknown> => !!endpoint && typeof endpoint === 'object')
            : [];
        const kept = new Set<string>();
        const stripped = list.map((endpoint) => {
            if (typeof endpoint.id !== 'string' || !endpoint.id) return { ...endpoint, apiKey: '' };
            const slot = customProviderId(endpoint.id);
            kept.add(slot);
            const named = settings.keySecrets[slot];
            const apiKey = typeof endpoint.apiKey === 'string' ? endpoint.apiKey.trim() : '';
            const here = this.secretValue(named);
            if (apiKey) {
                const secret = named ?? endpointSecretName(endpoint.id);
                if (apiKey !== here || !named) this.requireSecrets().setSecret(secret, apiKey);
                settings.keySecrets[slot] = secret;
            } else if (named && here) {
                // Cleared on this computer: emptied here, the binding kept for the others (as for vendor keys);
                // a secret the user named is let go instead.
                if (named.startsWith(OWN_SECRET_PREFIX)) this.release(named);
                else delete settings.keySecrets[slot];
            }
            // No key here and none typed: this computer simply has none; another computer's binding stays.
            return { ...endpoint, apiKey: '' };
        });
        // Endpoints that are gone take their keys with them.
        for (const slot of Object.keys(settings.keySecrets)) {
            if (!slot.startsWith(customProviderId('')) || kept.has(slot)) continue;
            this.release(settings.keySecrets[slot]);
            delete settings.keySecrets[slot];
        }
        settings.prefs.customEndpoints = JSON.stringify(stripped);
    }
}
