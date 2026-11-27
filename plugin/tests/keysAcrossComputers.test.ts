/**
 * Keys are kept per computer while data.json (which names where each key lives) syncs with the vault: one
 * computer having no key, or removing its own, must not take the key away from another.
 */
import { describe, expect, it } from 'vitest';
import { PrefStore, normalizeSettings, type AlphainOSettings, type SecretStore } from '../src/settings';

class Secrets implements SecretStore {
    readonly values = new Map<string, string>();
    getSecret(id: string) {
        return this.values.has(id) ? (this.values.get(id) as string) : null;
    }
    setSecret(id: string, secret: string) {
        this.values.set(id, secret);
    }
}

/** One computer: its own secret storage, and data.json as it is on its disk. */
function computer(data: unknown) {
    let settings: AlphainOSettings = normalizeSettings(JSON.parse(JSON.stringify(data)));
    const secrets = new Secrets();
    const prefs = new PrefStore(() => settings, () => {}, secrets);
    return {
        secrets,
        prefs,
        /** data.json as written to disk (what the vault's sync carries). */
        dataJson: () => JSON.parse(JSON.stringify(settings)),
        receive: (data: unknown) => {
            settings = normalizeSettings(JSON.parse(JSON.stringify(data)));
        },
    };
}

const endpoint = (id: string, apiKey: string) => ({ id, name: id, baseUrl: `https://${id}.example/v1`, apiKey, authStyle: 'bearer', models: [{ id: 'm', supportsVision: false, reasoningEffort: false }] });

describe('API key bindings across two computers sharing a vault', () => {
    it('saving one custom endpoint on the second computer leaves the other endpoint’s key on the first', () => {
        const mac = computer({});
        mac.prefs.set('customEndpoints', JSON.stringify([endpoint('ep-relay', 'KEY-RELAY'), endpoint('ep-lab', 'KEY-LAB')]));
        // The vault syncs data.json to the PC; its secret storage is empty.
        const pc = computer(mac.dataJson());
        const all = JSON.parse(pc.prefs.get('customEndpoints') as string);
        expect(all.map((e: any) => e.apiKey)).toEqual(['', '']);
        // On the PC the user types the lab endpoint's key into its card and saves (the card writes the whole list).
        all[1].apiKey = 'KEY-LAB-PC';
        pc.prefs.set('customEndpoints', JSON.stringify(all));
        // data.json syncs back to the Mac.
        mac.receive(pc.dataJson());
        const onMac = JSON.parse(mac.prefs.get('customEndpoints') as string);
        expect(onMac.map((e: any) => e.apiKey)).toEqual(['KEY-RELAY', 'KEY-LAB']);
        expect(JSON.parse(pc.prefs.get('customEndpoints') as string).map((e: any) => e.apiKey)).toEqual(['', 'KEY-LAB-PC']);
        // Nothing reached data.json.
        expect(JSON.stringify(mac.dataJson())).not.toMatch(/KEY-/);
    });

    it('a vendor key removed on one computer keeps working on the other', () => {
        const mac = computer({});
        mac.prefs.set('llmKeyDeepseek', 'DS-MAC');
        const pc = computer(mac.dataJson());
        pc.prefs.set('llmKeyDeepseek', 'DS-PC');
        pc.prefs.set('llmKeyDeepseek', ''); // "Remove … on this computer"
        expect(pc.prefs.get('llmKeyDeepseek')).toBe('');
        mac.receive(pc.dataJson());
        expect(mac.prefs.get('llmKeyDeepseek')).toBe('DS-MAC');
    });

    it('moving one inline endpoint key into secret storage keeps the other endpoints’ keys', () => {
        const mac = computer({
            prefs: { customEndpoints: JSON.stringify([endpoint('ep-old', 'INLINE-OLD'), endpoint('ep-new', '')]) },
            keySecrets: { 'custom:ep-new': 'alphaino-custom-ep-new' },
        });
        mac.secrets.setSecret('alphaino-custom-ep-new', 'KEY-NEW');
        const read = JSON.parse(mac.prefs.get('customEndpoints') as string);
        expect(read.map((e: any) => e.apiKey)).toEqual(['INLINE-OLD', 'KEY-NEW']);
        expect(mac.secrets.getSecret('alphaino-custom-ep-new')).toBe('KEY-NEW');
        expect(JSON.stringify(mac.dataJson())).not.toContain('INLINE-OLD');
    });

    it('deleting an endpoint lets its key go on this computer', () => {
        const mac = computer({});
        mac.prefs.set('customEndpoints', JSON.stringify([endpoint('ep-relay', 'KEY-RELAY')]));
        mac.prefs.set('customEndpoints', JSON.stringify([]));
        expect(mac.secrets.getSecret('alphaino-custom-ep-relay')).toBe('');
        expect(mac.dataJson().keySecrets).toEqual({});
    });
});
