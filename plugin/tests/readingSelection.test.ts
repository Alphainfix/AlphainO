import { describe, expect, it } from 'vitest';
import { findInSource, plainWithMap } from '../src/context/readingSelection';

const NOTE = [
    '# Bees', // 0
    '', // 1
    'Honey bees **communicate** through a *waggle dance* that tells [[Workers|other workers]] where `flowers` are.', // 2
    '', // 3
    '- First: the [angle](https://example.com) of the dance', // 4
    '- Second: its length', // 5
    '', // 6
    '> Bees eat nectar.', // 7
    '', // 8
    'Bees eat nectar and pollen.', // 9
].join('\n');

const slice = (range: { from: number; to: number } | null) => (range ? NOTE.slice(range.from, range.to) : null);

describe('finding a Reading view selection in the source', () => {
    it('finds plain text word for word', () => {
        expect(slice(findInSource(NOTE, 'nectar and pollen', 9, 9))).toBe('nectar and pollen');
    });

    it('finds rendered text across emphasis, links and code, closing the markup it opened', () => {
        expect(slice(findInSource(NOTE, 'communicate through a waggle dance', 2, 2))).toBe('**communicate** through a *waggle dance*');
        expect(slice(findInSource(NOTE, 'tells other workers where flowers', 2, 2))).toBe('tells [[Workers|other workers]] where `flowers`');
        expect(slice(findInSource(NOTE, 'the angle of the dance', 4, 4))).toBe('the [angle](https://example.com) of the dance');
    });

    it('finds text that spans list items, leaving their markers out of the comparison', () => {
        expect(slice(findInSource(NOTE, 'of the dance\nSecond: its', 4, 5))).toBe('of the dance\n- Second: its');
    });

    it('looks only in the selection’s own block, so a repeated phrase is not confused with another', () => {
        expect(slice(findInSource(NOTE, 'Bees eat nectar', 7, 7))).toBe('Bees eat nectar');
        expect(findInSource(NOTE, 'Bees eat nectar', 7, 7)?.from).toBe(NOTE.indexOf('> Bees eat nectar') + 2);
        expect(findInSource(NOTE, 'Bees eat nectar', 9, 9)?.from).toBe(NOTE.lastIndexOf('Bees eat nectar'));
    });

    it('offers nothing rather than a guess when the text is not in those lines', () => {
        expect(findInSource(NOTE, 'wasps', 0, 9)).toBeNull();
        expect(findInSource(NOTE, 'nectar and pollen', 2, 2)).toBeNull();
    });

    it('maps every kept character back to the source', () => {
        const { plain, map } = plainWithMap('a **b** [[c|d]]');
        expect(plain).toBe('a b d');
        expect(map.map((offset) => 'a **b** [[c|d]]'[offset])).toEqual(['a', ' ', 'b', ' ', 'd']);
    });
});
