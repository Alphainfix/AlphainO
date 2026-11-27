/**
 * A passage's question and answer as a comment, Q and A as AlphainZ writes them into a highlight's comment.
 * The comment's author is already AlphainO, so there is no signature line. The answer keeps its Markdown, with
 * headings turned into bold lines: a heading is far too large inside a comment, and after "A:" it would show
 * its "##".
 */
export function commentEntry(question: string, answer: string): string {
    const body = answer.trim().replace(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm, '**$1**');
    return `**Q:** ${question.trim()}\n\n**A:** ${body}`;
}
