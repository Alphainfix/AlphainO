/**
 * Keys never go into data.json: the settings page writes them under AlphainZ's
 * names (`llmKey…`, `embeddingKeyGoogle`, a hand-added endpoint's `apiKey`) and
 * PrefStore sends each to Obsidian's secret storage, recording only the
 * secret's name in `keySecrets`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readCustomEndpoints, writeCustomEndpoints, type CustomEndpoint } from '@beaver/agent-llm/customEndpoints';
import { installRuntime } from '../src/runtime';
import { PrefStore, endpointSecretName, isKeySetting, normalizeSettings, type AlphainOSettings, type SecretStore } from '../src/settings';
import { setLanguageForTests } from './obsidianStub';

class MemorySecrets implements SecretStore {
    readonly values = new Map<string, string>();
    getSecret(id: string): string | null {
        return this.values.has(id) ? this.values.get(id)! : null;
    }
    setSecret(id: string, secret: string): void {
        // Obsidian's rule for secret ids.
        if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid secret id: ${id}`);
        this.values.set(id, secret);
    }
}

let settings: AlphainOSettings;
let secrets: MemorySecrets;
let saves: number;
let prefs: PrefStore;

const dataJson = () => JSON.stringify(settings);

beforeEach(() => {
    settings = normalizeSettings({});
    secrets = new MemorySecrets();
    saves = 0;
    prefs = new PrefStore(() => settings, () => { saves += 1; }, secrets);
    installRuntime(prefs, false);
    setLanguageForTests('en');
});

const relay = (patch: Partial<CustomEndpoint> = {}): CustomEndpoint => ({
    id: 'ep-0a1b2c3d',
    name: 'Relay',
    baseUrl: 'https://relay.example/v1',
    apiKey: 'relay-secret',
    authStyle: 'bearer',
    models: [{ id: 'm1', supportsVision: false, reasoningEffort: false }],
    ...patch,
});

describe('which settings are keys', () => {
    it('are AlphainZ\'s llmKey… and embeddingKey… settings, nothing else', () => {
        expect(isKeySetting('llmKeyDeepseek')).toBe(true);
        expect(isKeySetting('llmKeyOpencodeGo')).toBe(true);
        expect(isKeySetting('embeddingKeyGoogle')).toBe(true);
        expect(isKeySetting('llmProvider')).toBe(false);
        expect(isKeySetting('customEndpoints')).toBe(false);
        expect(isKeySetting('llmKey')).toBe(false);
    });
});

describe('a vendor\'s key', () => {
    it('goes to a secret of its own, named for every provider the key unlocks, and never into data.json', () => {
        prefs.set('llmKeyDeepseek', 'sk-deepseek');
        expect(secrets.getSecret('alphaino-deepseek')).toBe('sk-deepseek');
        expect(settings.keySecrets.deepseek).toBe('alphaino-deepseek');
        expect(prefs.get('llmKeyDeepseek')).toBe('sk-deepseek');
        expect(dataJson()).not.toContain('sk-deepseek');
        expect(saves).toBe(1);
    });

    it('is written into the secret already chosen for it (Obsidian\'s secret picker)', () => {
        settings = normalizeSettings({ keySecrets: { zhipu: 'zhipu-key' } });
        secrets.setSecret('zhipu-key', 'zk-old');
        expect(prefs.get('llmKeyZhipu')).toBe('zk-old');
        prefs.set('llmKeyZhipu', 'zk-new');
        expect(secrets.getSecret('zhipu-key')).toBe('zk-new');
        expect(settings.keySecrets).toEqual({ zhipu: 'zhipu-key' });
    });

    it('reads as empty when no secret is named, or the named one is missing', () => {
        expect(prefs.get('llmKeyOpenai')).toBe('');
        settings.keySecrets.openai = 'gone';
        expect(prefs.get('llmKeyOpenai')).toBe('');
    });

    it('removed, empties a secret AlphainO named (on this computer: the name stays for the others), but only lets go of one the user named', () => {
        prefs.set('llmKeyOpenai', 'sk-openai');
        prefs.set('llmKeyOpenai', '');
        expect(secrets.getSecret('alphaino-openai')).toBe('');
        expect(prefs.get('llmKeyOpenai')).toBe('');
        // data.json syncs: another computer keeps its own key under the same name.
        expect(settings.keySecrets.openai).toBe('alphaino-openai');

        settings.keySecrets.zhipu = 'shared-zhipu';
        secrets.setSecret('shared-zhipu', 'zk-shared');
        prefs.clear('llmKeyZhipu');
        expect(secrets.getSecret('shared-zhipu')).toBe('zk-shared');
        expect(settings.keySecrets.zhipu).toBeUndefined();
        expect(prefs.get('llmKeyZhipu')).toBe('');
    });

    it('found in data.json (written some other way) moves to its secret when read', () => {
        settings = normalizeSettings({ prefs: { llmKeyOpenrouter: 'k-inline' } });
        expect(prefs.get('llmKeyOpenrouter')).toBe('k-inline');
        expect(settings.prefs.llmKeyOpenrouter).toBeUndefined();
        expect(secrets.getSecret('alphaino-openrouter')).toBe('k-inline');
        expect(dataJson()).not.toContain('k-inline');
    });

    it('is refused, rather than stored in data.json, when there is no secret storage', () => {
        const bare = new PrefStore(() => settings, () => {});
        expect(() => bare.set('llmKeyDeepseek', 'sk-nowhere')).toThrow(/secret storage/);
        expect(dataJson()).not.toContain('sk-nowhere');
        expect(bare.get('llmKeyDeepseek')).toBe('');
    });
});

describe('Google\'s embedding key', () => {
    it('is kept under the setting\'s own name, where main.ts reads it', () => {
        prefs.set('embeddingKeyGoogle', 'gk-embed');
        expect(settings.keySecrets.embeddingKeyGoogle).toBe('alphaino-embedding-key-google');
        expect(secrets.getSecret('alphaino-embedding-key-google')).toBe('gk-embed');
        expect(prefs.string('embeddingKeyGoogle')).toBe('gk-embed');
        expect(dataJson()).not.toContain('gk-embed');
    });
});

describe('a hand-added endpoint\'s key', () => {
    it('is lifted out of customEndpoints into a secret, and put back when the model layer reads them', () => {
        writeCustomEndpoints([relay()]);
        const stored = JSON.parse(String(settings.prefs.customEndpoints));
        expect(stored[0].apiKey).toBe('');
        expect(settings.keySecrets['custom:ep-0a1b2c3d']).toBe('alphaino-custom-ep-0a1b2c3d');
        expect(secrets.getSecret('alphaino-custom-ep-0a1b2c3d')).toBe('relay-secret');
        expect(dataJson()).not.toContain('relay-secret');
        expect(readCustomEndpoints()).toEqual([expect.objectContaining({ id: 'ep-0a1b2c3d', apiKey: 'relay-secret', name: 'Relay' })]);
    });

    it('changes with the endpoint, and goes with it when the endpoint is deleted', () => {
        writeCustomEndpoints([relay()]);
        writeCustomEndpoints([relay({ apiKey: 'relay-rotated' })]);
        expect(secrets.getSecret('alphaino-custom-ep-0a1b2c3d')).toBe('relay-rotated');
        writeCustomEndpoints([relay({ apiKey: '' })]);
        expect(secrets.getSecret('alphaino-custom-ep-0a1b2c3d')).toBe('');
        // Cleared on this computer; the name stays for another computer's key.
        expect(settings.keySecrets['custom:ep-0a1b2c3d']).toBe('alphaino-custom-ep-0a1b2c3d');
        writeCustomEndpoints([relay({ apiKey: 'relay-again' })]);
        writeCustomEndpoints([]);
        expect(secrets.getSecret('alphaino-custom-ep-0a1b2c3d')).toBe('');
        expect(Object.keys(settings.keySecrets)).toEqual([]);
    });

    it('follows an endpoint filed under a new id (a synced choice adopting it)', () => {
        writeCustomEndpoints([relay()]);
        writeCustomEndpoints([relay({ id: 'Lab.Relay_2' })]);
        const name = settings.keySecrets['custom:Lab.Relay_2'];
        expect(name).toMatch(/^alphaino-custom-lab-relay-2-[0-9a-z]+$/);
        expect(secrets.getSecret(name!)).toBe('relay-secret');
        expect(settings.keySecrets['custom:ep-0a1b2c3d']).toBeUndefined();
        expect(readCustomEndpoints()[0]).toMatchObject({ id: 'Lab.Relay_2', apiKey: 'relay-secret' });
    });

    it('names a valid secret for any id the model layer accepts', () => {
        for (const id of ['ep-0a1b2c3d', 'Relay.One', 'a_b', 'X']) expect(endpointSecretName(id)).toMatch(/^[a-z0-9-]+$/);
        expect(endpointSecretName('Relay.One')).not.toBe(endpointSecretName('relay-one'));
    });

    it('found inline in data.json moves to its secret on the next read', () => {
        settings = normalizeSettings({ prefs: { customEndpoints: JSON.stringify([relay({ apiKey: 'inline-key' })]) } });
        expect(readCustomEndpoints()[0].apiKey).toBe('inline-key');
        expect(dataJson()).not.toContain('inline-key');
        expect(secrets.getSecret('alphaino-custom-ep-0a1b2c3d')).toBe('inline-key');
    });

    it('keeps endpoints without a key as they are', () => {
        writeCustomEndpoints([relay({ apiKey: '' })]);
        expect(readCustomEndpoints()[0]).toMatchObject({ apiKey: '', baseUrl: 'https://relay.example/v1' });
        expect(Object.keys(settings.keySecrets)).toEqual([]);
    });
});

describe('other settings', () => {
    it('are stored as before, with AlphainZ\'s defaults underneath', () => {
        expect(prefs.get('conversationRail')).toBe(true);
        expect(prefs.get('customInstructions')).toBe('');
        expect(prefs.get('embeddingProvider')).toBe('');
        prefs.set('maxModelRequests', 40);
        prefs.set('embeddingProvider', 'google');
        expect(settings.prefs).toMatchObject({ maxModelRequests: 40, embeddingProvider: 'google' });
    });
});
