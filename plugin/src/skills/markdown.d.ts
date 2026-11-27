/** A Markdown file imported as its text (esbuild's text loader; vitest.config.ts does the same for tests). */
declare module '*.md' {
    const text: string;
    export default text;
}
