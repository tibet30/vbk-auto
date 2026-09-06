import type { ReactNode } from "react";

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function renderInline(value: string): ReactNode[] {
  const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^\)\n]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(value.slice(last, index));
    const token = match[0];
    if (token.startsWith("**") || token.startsWith("__")) nodes.push(<strong key={`${index}-strong`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`") && token.endsWith("`")) nodes.push(<code key={`${index}-code`}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("*") || token.startsWith("_")) nodes.push(<em key={`${index}-em`}>{token.slice(1, -1)}</em>);
    else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link ? safeHref(link[2]) : undefined;
      if (link && href) nodes.push(<a key={`${index}-link`} href={href} target="_blank" rel="noreferrer">{link[1]}</a>);
      else nodes.push(token);
    }
    last = index + token.length;
  }
  if (last < value.length) nodes.push(value.slice(last));
  return nodes;
}

function renderText(lines: string[], key: string): ReactNode {
  return <p key={key}>{lines.flatMap((line, index) => index ? [<br key={`${key}-br-${index}`} />, ...renderInline(line)] : renderInline(line))}</p>;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|") && splitTableRow(line).length >= 2;
}

function readTable(lines: string[], start: number): { rows: string[][]; nextIndex: number } | null {
  if (!isTableRow(lines[start] ?? "") || !isTableDivider(lines[start + 1] ?? "")) return null;
  const rows = [splitTableRow(lines[start]!)];
  let nextIndex = start + 2;
  while (nextIndex < lines.length && isTableRow(lines[nextIndex]!)) {
    rows.push(splitTableRow(lines[nextIndex]!));
    nextIndex += 1;
  }
  return rows.length > 1 ? { rows, nextIndex } : null;
}

function renderTable(rows: string[][], key: string): ReactNode {
  const [head, ...body] = rows;
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalise = (row: string[]) => Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
  return <div key={key} className="markdown-table-scroll">
    <table>
      <thead><tr>{normalise(head ?? []).map((cell, index) => <th key={index}>{renderInline(cell)}</th>)}</tr></thead>
      <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>
        {normalise(row).map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell)}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

export function renderAssistantMarkdown(content: string): ReactNode {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered = false;
  let code: string[] | null = null;

  const flushParagraph = () => { if (paragraph.length) { blocks.push(renderText(paragraph, `p-${blocks.length}`)); paragraph = []; } };
  const flushList = () => {
    if (!list.length) return;
    const Tag = ordered ? "ol" : "ul";
    blocks.push(<Tag key={`list-${blocks.length}`}>{list.map((item, index) => <li key={index}>{renderInline(item)}</li>)}</Tag>);
    list = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().startsWith("```")) {
      flushParagraph(); flushList();
      if (code) { blocks.push(<pre key={`code-${index}`}><code>{code.join("\n")}</code></pre>); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const table = readTable(lines, index);
    if (table) {
      flushParagraph(); flushList();
      blocks.push(renderTable(table.rows, `table-${blocks.length}`));
      index = table.nextIndex - 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (heading) { flushParagraph(); flushList(); const Tag = `h${heading[1].length}` as "h1" | "h2" | "h3"; blocks.push(<Tag key={`heading-${index}`}>{renderInline(heading[2])}</Tag>); continue; }
    if (unordered || numbered) { flushParagraph(); if (list.length && ordered !== Boolean(numbered)) flushList(); ordered = Boolean(numbered); list.push((unordered ?? numbered)![1]); continue; }
    flushList(); paragraph.push(line);
  }
  const remainingCode = code as string[] | null;
  if (remainingCode) blocks.push(<pre key={`code-${blocks.length}`}><code>{remainingCode.join("\n")}</code></pre>);
  flushParagraph(); flushList();
  return <>{blocks}</>;
}
