import { describe, expect, it } from 'vitest';
import { bm25Rank, countTerm, phraseTest } from '../src/search/keyword';
import {
    headingForLink,
    isIndexablePath,
    isUnderFolder,
    linkTarget,
    normalizeFolderPath,
    titleOf,
    wikilink,
} from '../src/search/paths';
import { hashString, normalizeText, parseQuery, queryTerms, tokenize, trimText } from '../src/search/text';

describe('tokenize', () => {
    it('splits Latin text into case-folded words', () => {
        expect(tokenize('Hello, World! GPT-4 is fine')).toEqual(['hello', 'world', 'gpt', '4', 'is', 'fine']);
    });

    it('folds full-width letters and digits', () => {
        expect(tokenize('ＡＢＣ１２３ Ｔest')).toEqual(['abc123', 'test']);
        expect(normalizeText('ＡＢＣ')).toBe('abc');
    });

    it('gives each CJK character and each neighbouring pair', () => {
        expect(tokenize('机器学习')).toEqual(['机', '机器', '器', '器学', '学', '学习', '习']);
    });

    it('keeps a single CJK character as a token of its own', () => {
        expect(tokenize('猫')).toEqual(['猫']);
    });

    it('does not pair characters across punctuation, spaces or Latin words', () => {
        expect(tokenize('猫，狗')).toEqual(['猫', '狗']);
        expect(tokenize('用GPT做机器')).toEqual(['用', 'gpt', '做', '做机', '机', '机器', '器']);
    });

    it('treats kana and Hangul like Han characters', () => {
        expect(tokenize('ひらが')).toEqual(['ひ', 'ひら', 'ら', 'らが', 'が']);
        expect(tokenize('한국어')).toEqual(['한', '한국', '국', '국어', '어']);
    });

    it('handles characters outside the Basic Multilingual Plane', () => {
        expect(tokenize('\u{20000}\u{20001}')).toEqual(['\u{20000}', '\u{20000}\u{20001}', '\u{20001}']);
    });

    it('keeps letters with accents and other alphabets whole', () => {
        expect(tokenize('Café naïve Привет')).toEqual(['café', 'naïve', 'привет']);
    });
});

describe('queryTerms', () => {
    it('lists each distinct term once, with how it is matched', () => {
        expect(queryTerms('猫 cat 猫')).toEqual([
            { term: '猫', kind: 'cjk' },
            { term: 'cat', kind: 'word' },
        ]);
    });

    it('gives the same terms as tokenize for a short query', () => {
        const terms = queryTerms('机器学习 and Gardening').map((entry) => entry.term);
        expect(new Set(terms)).toEqual(new Set(tokenize('机器学习 and Gardening')));
    });

    it('drops the single characters of a long CJK query before its pairs', () => {
        expect(queryTerms('机器学习', 3).map((entry) => entry.term)).toEqual(['机器', '器学', '学习']);
    });

    it('then drops one- and two-letter words', () => {
        expect(queryTerms('a to cat dog', 2).map((entry) => entry.term)).toEqual(['cat', 'dog']);
    });

    it('never returns more than the limit', () => {
        const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
        expect(queryTerms(words).length).toBe(32);
    });
});

describe('countTerm', () => {
    const word = (term: string) => ({ term, kind: 'word' as const });
    const cjk = (term: string) => ({ term, kind: 'cjk' as const });

    it('counts a Latin word only as a whole word', () => {
        expect(countTerm('cat category cat-food concat cat', word('cat'))).toBe(3);
        expect(countTerm('the cat', word('he'))).toBe(0);
    });

    it('sees a word next to CJK text as a whole word', () => {
        expect(countTerm('用gpt做', word('gpt'))).toBe(1);
    });

    it('counts overlapping CJK occurrences', () => {
        expect(countTerm('哈哈哈', cjk('哈哈'))).toBe(2);
        expect(countTerm('机器学习和机器人', cjk('机器'))).toBe(2);
    });

    it('does not find a CJK pair across a separator', () => {
        expect(countTerm('机，器', cjk('机器'))).toBe(0);
        expect(countTerm('机 器', cjk('机器'))).toBe(0);
    });
});

describe('bm25Rank', () => {
    const doc = (text: string, head = '') => ({
        norm: normalizeText(text),
        head: normalizeText(head),
        len: text.length + head.length,
    });

    it('ranks a passage with more of the query terms higher, and omits passages with none', async () => {
        const docs = [doc('apples and oranges'), doc('apples apples apples'), doc('nothing relevant here')];
        const ranked = await bm25Rank(docs, queryTerms('apples oranges'), 10);
        expect(ranked.map((match) => match.doc)).toEqual([docs[0], docs[1]]);
        expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it('weighs a term in the title or heading above one in the body', async () => {
        const docs = [doc('about bees and honey', 'Gardening'), doc('about gardens', 'Bees')];
        const ranked = await bm25Rank(docs, queryTerms('bees'), 10);
        expect(ranked[0].doc).toBe(docs[1]);
    });

    it('prefers a rarer term', async () => {
        const docs = [doc('common common rare'), doc('common common common'), doc('common again')];
        const ranked = await bm25Rank(docs, queryTerms('common rare'), 10);
        expect(ranked[0].doc).toBe(docs[0]);
    });

    it('returns at most the limit, and nothing for no terms or no passages', async () => {
        const docs = Array.from({ length: 5 }, () => doc('apple'));
        expect(await bm25Rank(docs, queryTerms('apple'), 2)).toHaveLength(2);
        expect(await bm25Rank(docs, [], 5)).toEqual([]);
        expect(await bm25Rank([], queryTerms('apple'), 5)).toEqual([]);
    });
});

describe('hashString', () => {
    it('is the same for the same text and different for different text', () => {
        expect(hashString('abc')).toBe(hashString('abc'));
        expect(hashString('abc')).not.toBe(hashString('abd'));
        expect(hashString('')).toBe(hashString(''));
    });

    it('tells apart texts that differ only in length', () => {
        expect(hashString('a')).not.toBe(hashString('aa'));
    });
});

describe('trimText', () => {
    it('leaves a short text alone', () => {
        expect(trimText('short', 100)).toBe('short');
    });

    it('cuts a long text with an ellipsis, at a word break when one is near', () => {
        const text = `${'word '.repeat(50)}end`;
        const cut = trimText(text, 52);
        expect(cut.endsWith(' …')).toBe(true);
        expect(cut.length).toBeLessThanOrEqual(54);
        expect(cut.startsWith('word word')).toBe(true);
    });

    it('never leaves half of a surrogate pair', () => {
        const cut = trimText('😀'.repeat(10), 5);
        expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut)).toBe(false);
    });
});

describe('paths', () => {
    it('normalises folder paths', () => {
        expect(normalizeFolderPath('/Projects//AI/')).toBe('Projects/AI');
        expect(normalizeFolderPath('Projects\\AI')).toBe('Projects/AI');
        expect(normalizeFolderPath('./')).toBe('');
        expect(normalizeFolderPath('')).toBe('');
    });

    it('tests folder membership by whole path segments, ignoring case', () => {
        expect(isUnderFolder('Projects/AI/a.md', 'Projects')).toBe(true);
        expect(isUnderFolder('projects/ai/a.md', 'Projects/AI')).toBe(true);
        expect(isUnderFolder('Projects2/a.md', 'Projects')).toBe(false);
        expect(isUnderFolder('a.md', '')).toBe(true);
    });

    it('searches Markdown notes outside hidden and excluded folders', () => {
        expect(isIndexablePath('Notes/a.md', [])).toBe(true);
        expect(isIndexablePath('Notes/a.MD', [])).toBe(true);
        expect(isIndexablePath('Notes/a.png', [])).toBe(false);
        expect(isIndexablePath('Agent/.alphaino/a.md', [])).toBe(false);
        expect(isIndexablePath('.obsidian/a.md', [])).toBe(false);
        expect(isIndexablePath('Notes/.hidden.md', [])).toBe(false);
        expect(isIndexablePath('Templates/t.md', ['Templates'])).toBe(false);
        expect(isIndexablePath('Archive/Old/t.md', ['/archive/old/'])).toBe(false);
        expect(isIndexablePath('Archive/New/t.md', ['Archive/Old'])).toBe(true);
        expect(isIndexablePath('Notes/a.md', [''])).toBe(true);
    });

    it('names notes and writes links the way Obsidian does', () => {
        expect(titleOf('Folder/My note.md')).toBe('My note');
        expect(linkTarget('Folder/My note.md')).toBe('Folder/My note');
        expect(wikilink('Folder/My note.md')).toBe('[[Folder/My note]]');
        expect(wikilink('Folder/My note.md', 'Methods')).toBe('[[Folder/My note#Methods]]');
        expect(headingForLink('Pros: a | b ^ c #d')).toBe('Pros a b c d');
        expect(headingForLink('x %% y [[z]]')).toBe('x y z');
        expect(wikilink('n.md', 'a: b')).toBe('[[n#a b]]');
    });
});

describe('parseQuery', () => {
    it('separates quoted phrases from the other words', () => {
        expect(parseQuery('bees "winter cluster" honey')).toEqual({ text: 'bees honey', phrases: ['winter cluster'] });
        expect(parseQuery('“Winter Cluster” and "queen bee"')).toEqual({ text: 'and', phrases: ['Winter Cluster', 'queen bee'] });
        expect(parseQuery('"only a phrase"')).toEqual({ text: '', phrases: ['only a phrase'] });
    });

    it('leaves a query without quotes, an empty pair, or a quote never closed as it is', () => {
        expect(parseQuery('  plain   words ')).toEqual({ text: 'plain words', phrases: [] });
        expect(parseQuery('a "" b')).toEqual({ text: 'a b', phrases: [] });
        expect(parseQuery('say "hello')).toEqual({ text: 'say "hello', phrases: [] });
    });
});

describe('phraseTest', () => {
    const doc = (text: string, head = '') => ({ norm: normalizeText(text), head: normalizeText(head), len: text.length });

    it('finds a literal phrase whatever its case, and whatever whitespace separates its words', () => {
        const test = phraseTest('Winter  Cluster');
        expect(test(doc('The winter cluster keeps warm.'))).toBe(true);
        expect(test(doc('A line that ends with winter\ncluster on the next.'))).toBe(true);
        expect(test(doc('cluster of winter'))).toBe(false);
        expect(test(doc('winterclusters'))).toBe(false);
    });

    it('counts the title and headings as part of the passage', () => {
        expect(phraseTest('garden planning')(doc('Some words.', 'Garden planning review'))).toBe(true);
    });

    it('matches one word or a CJK phrase as text, and takes punctuation literally', () => {
        expect(phraseTest('bee')(doc('A beehive.'))).toBe(true);
        expect(phraseTest('机器学习')(doc('关于机器学习的笔记'))).toBe(true);
        expect(phraseTest('机器学习')(doc('机器 学习'))).toBe(false);
        expect(phraseTest('c++ code')(doc('Some C++ code here'))).toBe(true);
        expect(phraseTest('a.b')(doc('axb'))).toBe(false);
        expect(phraseTest('a.b')(doc('see a.b now'))).toBe(true);
    });
});
