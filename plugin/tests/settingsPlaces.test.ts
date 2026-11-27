import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({ apiVersion: '1.11.4', getLanguage: () => 'en' }));

const { atAlphainOSettings } = await import('../src/runtime');

describe('AlphainZ’s settings places, as AlphainO’s', () => {
    it('puts the English places as AlphainO’s settings', () => {
        expect(atAlphainOSettings('Raise "Output tokens per reply" in Settings → Advanced, or ask for less.')).toBe(
            'Raise "Output tokens per reply" in AlphainO’s settings, or ask for less.',
        );
        expect(atAlphainOSettings('Check the key under Settings → Model → Providers; indexing resumes once it works.')).toBe(
            'Check the key under AlphainO’s settings; indexing resumes once it works.',
        );
        expect(atAlphainOSettings('Choose another provider under Settings → Model.')).toBe('Choose another provider under AlphainO’s settings.');
    });

    it('puts the Chinese places as AlphainO 设置', () => {
        expect(atAlphainOSettings('请在 设置 → 模型 → 服务商 中检查 key；恢复正常后会继续索引。')).toBe('请在 AlphainO 设置 中检查 key；恢复正常后会继续索引。');
        expect(atAlphainOSettings('这是 设置 → 高级 中“每个问题的模型请求数”的上限。')).toBe('这是 AlphainO 设置 中“每个问题的模型请求数”的上限。');
    });

    it('leaves other text alone', () => {
        expect(atAlphainOSettings('Settings are saved.')).toBe('Settings are saved.');
    });
});
