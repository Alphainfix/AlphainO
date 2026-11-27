import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCallPart } from '@beaver/agent-core/agents/types';
import { buildSystemPrompt } from '../src/agent/systemPrompt';
import { READ_SKILL_SCHEMA, SKILLS, SKILL_TOOLS, findSkill, parseSkillFile, readSkill, skillTitle, skillsGuidance } from '../src/skills';
import { ownToolLabel, toolBaseName } from '../src/view/parts';
import { setLanguageForTests } from './obsidianStub';

const SKILLS_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const NAMES = ['obsidian-markdown', 'obsidian-bases', 'json-canvas'];

/** Every file under a folder, as paths from it. */
function filesUnder(folder: string, prefix = ''): string[] {
    return readdirSync(path.join(folder, prefix)).flatMap((name) => {
        const relative = prefix ? `${prefix}/${name}` : name;
        return statSync(path.join(folder, relative)).isDirectory() ? filesUnder(folder, relative) : [relative];
    });
}

describe('the bundled skills', () => {
    it('are the three file-format skills of Obsidian’s connector, named as their folders', () => {
        expect(SKILLS.map((skill) => skill.name)).toEqual(NAMES);
        const folders = readdirSync(SKILLS_FOLDER).filter((name) => statSync(path.join(SKILLS_FOLDER, name)).isDirectory());
        expect(folders.sort()).toEqual([...NAMES].sort());
    });

    it('carry every file of their folders, word for word', () => {
        for (const skill of SKILLS) {
            const folder = path.join(SKILLS_FOLDER, skill.name);
            expect(Object.keys(skill.files).sort()).toEqual(filesUnder(folder).filter((file) => file !== 'SKILL.md').sort());
            for (const [file, text] of Object.entries(skill.files)) expect(text).toBe(readFileSync(path.join(folder, file), 'utf8'));
            expect(skill.instructions).toBe(parseSkillFile(readFileSync(path.join(folder, 'SKILL.md'), 'utf8')).body);
        }
    });

    it('have what the Agent Skills specification asks of a name and a description', () => {
        for (const skill of SKILLS) {
            expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
            expect(skill.name.length).toBeLessThanOrEqual(64);
            expect(skill.description.trim().length).toBeGreaterThan(0);
            expect(skill.description.length).toBeLessThanOrEqual(1024);
            expect(skill.instructions.startsWith('---')).toBe(false);
        }
    });

    it('link only to files they carry', () => {
        for (const skill of SKILLS) {
            const links = [skill.instructions, ...Object.values(skill.files)].flatMap((text) => [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]));
            // Web links, and the "[text](url)" of the Markdown skill's own example, point nowhere in the skill.
            const own = links.filter((link) => !/^[a-z]+:/i.test(link) && link !== 'url');
            expect(own.length, skill.name).toBeGreaterThan(0);
            for (const link of own) expect(Object.keys(skill.files), `${skill.name}: ${link}`).toContain(link);
        }
    });

    it('keep their MIT licence beside them', () => {
        const licence = readFileSync(path.join(SKILLS_FOLDER, 'LICENSE'), 'utf8');
        expect(licence).toContain('MIT License');
        expect(licence).toContain('Steph Ango');
    });

    it('have titles for the chat', () => {
        expect(SKILLS.map((skill) => skill.title)).toEqual(['Obsidian Flavored Markdown', 'Obsidian Bases', 'JSON Canvas']);
        expect(skillTitle(' OBSIDIAN-BASES ')).toBe('Obsidian Bases');
        expect(skillTitle('obsidian-cli')).toBe('obsidian-cli');
        expect(skillTitle(undefined)).toBe('');
    });
});

describe('parseSkillFile', () => {
    it('reads the frontmatter fields, quoted or not, and keeps the text after them', () => {
        const parsed = parseSkillFile('---\nname: demo\ndescription: "Use when: a colon is in it"\n---\n\n# Demo\n\nBody.\n');
        expect(parsed.fields).toEqual({ name: 'demo', description: 'Use when: a colon is in it' });
        expect(parsed.body).toBe('# Demo\n\nBody.');
    });

    it('takes Windows line ends, and a file without frontmatter as all text', () => {
        expect(parseSkillFile('---\r\nname: demo\r\n---\r\nBody').fields.name).toBe('demo');
        expect(parseSkillFile('# Just text\n')).toEqual({ fields: {}, body: '# Just text' });
    });
});

describe('read_skill', () => {
    it('is offered with the skills’ names as its only choices', () => {
        expect(SKILL_TOOLS.schemas).toEqual([READ_SKILL_SCHEMA]);
        const parameters = READ_SKILL_SCHEMA.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
        expect(parameters.properties.name.enum).toEqual(NAMES);
        expect(parameters.required).toEqual(['name']);
    });

    it('hands over a skill’s instructions without the frontmatter, and lists its files', async () => {
        const result = (await SKILL_TOOLS.dispatch('read_skill', { name: 'obsidian-markdown' }, { toolCallId: 'c1' })) as Record<string, unknown>;
        expect(result).toEqual({
            skill: 'obsidian-markdown',
            summary: findSkill('obsidian-markdown')?.description,
            instructions: findSkill('obsidian-markdown')?.instructions,
            files: ['references/CALLOUTS.md', 'references/EMBEDS.md', 'references/PROPERTIES.md'],
        });
        expect(result.instructions).toMatch(/^# Obsidian Flavored Markdown Skill/);
        expect(result.instructions).not.toContain('name: obsidian-markdown');
    });

    it('reads one of a skill’s files, named as its instructions link it or by its name alone', () => {
        const text = findSkill('obsidian-markdown')?.files['references/CALLOUTS.md'];
        for (const file of [
            'references/CALLOUTS.md',
            './references/CALLOUTS.md',
            'CALLOUTS.md',
            'callouts.md',
            'obsidian-markdown/references/CALLOUTS.md',
            '/skills/obsidian-markdown/references/CALLOUTS.md',
            '`references/CALLOUTS.md`',
        ]) {
            expect(readSkill({ name: 'obsidian-markdown', file }), file).toEqual({ skill: 'obsidian-markdown', file: 'references/CALLOUTS.md', text });
        }
    });

    it('gives the instructions for SKILL.md or an empty file, and takes a name in any case', () => {
        const instructions = findSkill('json-canvas')?.instructions;
        expect(readSkill({ name: 'JSON-Canvas', file: 'SKILL.md' }).instructions).toBe(instructions);
        expect(readSkill({ name: 'json-canvas', file: '' }).instructions).toBe(instructions);
    });

    it('says what there is when a skill or a file is not there', () => {
        expect(readSkill({ name: 'obsidian-cli' })).toEqual({ error: 'There is no skill "obsidian-cli". The skills are obsidian-markdown, obsidian-bases, json-canvas.' });
        expect(readSkill({})).toEqual({ error: 'There is no skill by that name. The skills are obsidian-markdown, obsidian-bases, json-canvas.' });
        expect(readSkill({ name: 'obsidian-bases', file: 'references/EXAMPLES.md' })).toEqual({
            error: 'The skill obsidian-bases has no file "references/EXAMPLES.md". Its files are references/FUNCTIONS_REFERENCE.md.',
        });
    });

    it('reads nothing but the files the skill carries', () => {
        for (const file of ['../../package.json', '../obsidian-bases/SKILL.md', '/etc/hosts', '../../../LICENSE', 'references']) {
            expect(readSkill({ name: 'obsidian-markdown', file }).error, file).toMatch(/^The skill obsidian-markdown has no file/);
        }
    });
});

describe('the chat’s step row', () => {
    const call = (args: Record<string, unknown>) => ({ part_kind: 'tool-call', tool_name: 'read_skill', tool_call_id: 'c1', args }) as unknown as ToolCallPart;

    afterEach(() => setLanguageForTests('en'));

    it('names the skill by its title, and the file when it reads one', () => {
        expect(ownToolLabel(call({ name: 'obsidian-bases' }))).toBe('Loading skill: Obsidian Bases');
        expect(ownToolLabel(call({ name: 'obsidian-bases', file: 'references/FUNCTIONS_REFERENCE.md' }))).toBe('Loading skill: Obsidian Bases, FUNCTIONS_REFERENCE.md');
        expect(ownToolLabel(call({ name: 'obsidian-bases', file: 'SKILL.md' }))).toBe('Loading skill: Obsidian Bases');
        expect(ownToolLabel(call({}))).toBe('Loading skill');
        expect(toolBaseName('read_skill')).toBe('Loading skill');
    });

    it('is in Chinese when Obsidian is', () => {
        setLanguageForTests('zh');
        expect(ownToolLabel(call({ name: 'json-canvas' }))).toBe('载入技能：JSON Canvas');
        expect(ownToolLabel(call({ name: 'obsidian-markdown', file: 'references/CALLOUTS.md' }))).toBe('载入技能：Obsidian Flavored Markdown，CALLOUTS.md');
    });
});

describe('the skills in the system prompt', () => {
    it('lists every skill by name and description, and says how to load one and what it comes to here', () => {
        const prompt = buildSystemPrompt({ vaultName: 'Vault', now: new Date('2026-11-27T12:00:00Z'), sections: [skillsGuidance()] });
        for (const skill of SKILLS) expect(prompt).toContain(`- \`${skill.name}\`: ${skill.description}`);
        expect(prompt).toContain('load it with `read_skill` first');
        expect(prompt).toContain('`read_note` reads .base and .canvas files too');
        expect(prompt).toContain('You cannot create a .base or .canvas file');
    });
});
