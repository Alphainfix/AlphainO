/**
 * Obsidian's skills: the instructions behind Obsidian's official connectors
 * (https://obsidian.md/help/connectors) for its Markdown, Bases and Canvas
 * formats, copied unchanged into plugin/skills from obsidianmd/obsidian-skills
 * and bundled into main.js. They are loaded the way the Agent Skills guide
 * describes (https://agentskills.io/client-implementation/adding-skills-support):
 * the system prompt lists each skill's name and description, `read_skill`
 * gives the model a skill's instructions when a task calls for it, and the
 * files the instructions link (references/…) one at a time.
 *
 * The connector's other skills need a shell (the Obsidian CLI, Headless,
 * Defuddle, Knap), which AlphainO does not have; plugin/skills/README.md says
 * more.
 */
/*! Obsidian skills (plugin/skills), from https://github.com/obsidianmd/obsidian-skills
 * MIT License
 *
 * Copyright (c) 2026 Steph Ango (@kepano)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { ToolSchema } from '@beaver/agent-llm/types';
import type { ToolSet } from '../agent/tools';
import markdownSkill from '../../skills/obsidian-markdown/SKILL.md';
import markdownCallouts from '../../skills/obsidian-markdown/references/CALLOUTS.md';
import markdownEmbeds from '../../skills/obsidian-markdown/references/EMBEDS.md';
import markdownProperties from '../../skills/obsidian-markdown/references/PROPERTIES.md';
import basesSkill from '../../skills/obsidian-bases/SKILL.md';
import basesFunctions from '../../skills/obsidian-bases/references/FUNCTIONS_REFERENCE.md';
import canvasSkill from '../../skills/json-canvas/SKILL.md';
import canvasExamples from '../../skills/json-canvas/references/EXAMPLES.md';

export interface Skill {
    /** What the model calls it by (`obsidian-markdown`): the `name` in its frontmatter. */
    name: string;
    /** What it is for and when to use it: all the model sees of it until it loads it. */
    description: string;
    /** Its title, for the chat's step row: the heading its instructions start with, less "Skill". */
    title: string;
    /** SKILL.md without its frontmatter. */
    instructions: string;
    /** Its other files, by their path in the skill's folder (`references/CALLOUTS.md`). */
    files: Readonly<Record<string, string>>;
}

/**
 * A SKILL.md's frontmatter fields and the text after them. The fields are read
 * as `key: value` lines, which is all the bundled skills use; a value may be
 * quoted. Without frontmatter, all of it is the text.
 */
export function parseSkillFile(source: string): { fields: Record<string, string>; body: string } {
    const text = source.replace(/\r\n?/g, '\n');
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
    if (!match) return { fields: {}, body: text.trim() };
    const fields: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
        const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (!field) continue;
        const value = field[2].trim();
        fields[field[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
    }
    return { fields, body: text.slice(match[0].length).trim() };
}

function skill(source: string, files: Record<string, string>): Skill {
    const { fields, body } = parseSkillFile(source);
    const name = fields.name ?? '';
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    return {
        name,
        description: fields.description ?? '',
        title: heading ? heading.replace(/\s+skill$/i, '') : name,
        instructions: body,
        files,
    };
}

/** The skills AlphainO carries, in the order the system prompt lists them. */
export const SKILLS: readonly Skill[] = [
    skill(markdownSkill, {
        'references/CALLOUTS.md': markdownCallouts,
        'references/EMBEDS.md': markdownEmbeds,
        'references/PROPERTIES.md': markdownProperties,
    }),
    skill(basesSkill, { 'references/FUNCTIONS_REFERENCE.md': basesFunctions }),
    skill(canvasSkill, { 'references/EXAMPLES.md': canvasExamples }),
];

/** The skill a name names (case does not matter), if it is one of them. */
export function findSkill(name: unknown): Skill | undefined {
    const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
    return SKILLS.find((skill) => skill.name === wanted);
}

/** A skill's title for the chat ("Obsidian Bases"); the name as given when it is not one of them. */
export function skillTitle(name: unknown): string {
    return findSkill(name)?.title ?? (typeof name === 'string' ? name.trim() : '');
}

export const READ_SKILL_SCHEMA: ToolSchema = {
    name: 'read_skill',
    description:
        'Load a skill from the list in the system prompt: Obsidian’s own instructions for a kind of task. Call it with the skill’s name '
        + 'before the task, and follow what it says; it stays in the conversation, so load each skill once. With `file`, read one of the '
        + 'files its instructions link (references/…) instead, when you need it.',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', enum: SKILLS.map((skill) => skill.name), description: 'The skill’s name.' },
            file: {
                type: 'string',
                description: 'One of the skill’s files, as its instructions link it, e.g. "references/CALLOUTS.md". Leave it out to load the instructions.',
            },
        },
        required: ['name'],
    },
};

/** A file argument as a path in the skill's folder: without quotes, a leading `./` or `/`, or the folders above the skill's own. */
function pathInSkill(skill: Skill, value: string): string {
    let path = value.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/');
    const inside = path.toLowerCase().lastIndexOf(`${skill.name}/`);
    if (inside >= 0) path = path.slice(inside + skill.name.length + 1);
    return path.replace(/^(\.?\/)+/, '');
}

/**
 * What `read_skill` answers: a skill's instructions and the list of its files,
 * or one of those files. A file is found by its path in the skill's folder or
 * by its name alone; nothing outside the bundled files can be read.
 */
export function readSkill(args: Record<string, unknown>): Record<string, unknown> {
    const skill = findSkill(args.name);
    if (!skill) {
        const given = typeof args.name === 'string' && args.name.trim() ? `"${args.name.trim()}"` : 'by that name';
        return { error: `There is no skill ${given}. The skills are ${SKILLS.map((one) => one.name).join(', ')}.` };
    }
    const paths = Object.keys(skill.files);
    const wanted = typeof args.file === 'string' ? pathInSkill(skill, args.file) : '';
    if (wanted === '' || wanted.toLowerCase() === 'skill.md') {
        return {
            skill: skill.name,
            summary: skill.description,
            instructions: skill.instructions,
            ...(paths.length > 0 ? { files: paths } : {}),
        };
    }
    const lower = wanted.toLowerCase();
    const path =
        paths.find((candidate) => candidate.toLowerCase() === lower)
        ?? paths.find((candidate) => candidate.slice(candidate.lastIndexOf('/') + 1).toLowerCase() === lower);
    if (!path) {
        return { error: `The skill ${skill.name} has no file "${wanted}". ${paths.length > 0 ? `Its files are ${paths.join(', ')}.` : 'It has no other files.'}` };
    }
    return { skill: skill.name, file: path, text: skill.files[path] };
}

/** `read_skill` and what runs it, as one of the chat's tool sets. */
export const SKILL_TOOLS: ToolSet = {
    schemas: SKILLS.length > 0 ? [READ_SKILL_SCHEMA] : [],
    dispatch: async (name, args) => (name === 'read_skill' ? readSkill(args) : { error: `No tool named ${name}.` }),
};

/**
 * The system prompt's part on skills (it reads English): when to load one,
 * each skill's name and description, and what they come to with AlphainO's
 * tools, which write Markdown notes only.
 */
export function skillsGuidance(): string {
    if (SKILLS.length === 0) return '';
    return [
        'Skills hold Obsidian’s own instructions for its file formats, from its official connector (obsidianmd/obsidian-skills). '
            + 'When a task matches one, such as writing into a note with `edit_note`, putting a base into a note or reading a canvas, '
            + 'load it with `read_skill` first and follow it. A plain answer about the notes needs none. The skills:',
        ...SKILLS.map((skill) => `- \`${skill.name}\`: ${skill.description}`),
        'Here you write Markdown, in your answers and with `edit_note`; a base goes into a note as a `base` code block, and '
            + '`read_note` reads .base and .canvas files too. You cannot create a .base or .canvas file or change one: when asked to, '
            + 'say so, and offer a `base` code block in a note instead.',
    ].join('\n');
}
