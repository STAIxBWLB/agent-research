/** Original UTF-16 source offsets; text/path preserve the legacy hygiene scanner's normalization. */
export interface MarkdownHeading {
  start: number;
  end: number;
  level: number;
  text: string;
  rawText: string;
  parent: number;
  path: string[];
}

/** Deterministic ATX/Setext extraction; the caller controls which block/comment positions are hidden. */
export function markdownHeadings(manuscript: string, hidden: Uint8Array): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [], stack: number[] = [];
  const add = (start: number, end: number, level: number, legacyRaw: string, exactRaw = legacyRaw) => {
    const text = legacyRaw.trim().replace(/\s+/g, " ");
    while (stack.length && headings[stack.at(-1)!]!.level >= level) stack.pop();
    const parent = stack.at(-1) ?? -1;
    headings.push({start, end, level, text, rawText: exactRaw.trim(), parent, path: [...(parent >= 0 ? headings[parent]!.path : []), text]});
    stack.push(headings.length - 1);
  };
  let paragraph: {start: number; end: number; lines: string[]} | undefined;
  for (const match of manuscript.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) break;
    const start = match.index, line = match[0].replace(/\r?\n$/, "");
    if (hidden[start + /^[ \t]*/.exec(line)![0].length] || !line.trim()) { paragraph = undefined; continue; }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+([^\r\n]*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) { add(start, start + line.length, atx[1]!.length, atx[2] ?? ""); paragraph = undefined; continue; }
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (underline && paragraph) {
      add(paragraph.start, start + line.length, underline[1]![0] === "=" ? 1 : 2, paragraph.lines.join(" "), manuscript.slice(paragraph.start, paragraph.end));
      paragraph = undefined; continue;
    }
    if (/^ {0,3}(?:[-+*]|[0-9]+[.)])(?:[ \t]|$)|^ {0,3}>|^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line) && !paragraph) { paragraph = undefined; continue; }
    if (paragraph) { paragraph.lines.push(line); paragraph.end = start + line.length; }
    else paragraph = {start, end: start + line.length, lines: [line]};
  }
  return headings;
}
