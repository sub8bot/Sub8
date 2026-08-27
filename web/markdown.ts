export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitRow(line: string | undefined): string[] {
  let t = String(line || "").trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function isTableRow(line: string | undefined): boolean {
  const t = String(line || "").trim();
  return t.startsWith("|") && t.includes("|", 1);
}

function isSepRow(line: string | undefined): boolean {
  if (!isTableRow(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/\s/g, "")));
}

function renderInline(s: string): string {
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noreferrer">$1</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)(?=$|[\s)])/g, `$1<a href="$2" target="_blank" rel="noreferrer">$2</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=$|[^\w*])/g, "$1<em>$2</em>");
  return s;
}

function tableHtml(header: string[], rows: string[][]): string {
  const th = header.map((c) => `<th>${renderInline(c)}</th>`).join("");
  const body = rows
    .filter((r) => r.some((c) => c))
    .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function flushList(kind: ListKind, items: string[]): string {
  if (!items.length) return "";
  const tag = kind === "ol" ? "ol" : "ul";
  return `<${tag} class="md-list">${items.map((t) => `<li>${renderInline(t)}</li>`).join("")}</${tag}>`;
}

type ListKind = "ul" | "ol";

function renderBlocks(s: string): string {
  const lines = String(s).split("\n");
  const out: string[] = [];
  let i = 0;
  let listKind: ListKind | null = null;
  let listItems: string[] = [];
  const endList = () => {
    if (listKind) {
      out.push(flushList(listKind, listItems));
      listKind = null;
      listItems = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      endList();
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isSepRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(tableHtml(header, rows));
      continue;
    }
    const fence = line.match(/^\u0000FENCE(\d+)\u0000$/);
    if (fence) {
      endList();
      out.push(line);
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      endList();
      const n = heading[1]?.length ?? 1;
      out.push(`<h${n} class="md-h">${renderInline(heading[2] ?? "")}</h${n}>`);
      i += 1;
      continue;
    }
    if (/^(&gt;|>)\s?/.test(line)) {
      endList();
      const quote: string[] = [];
      while (i < lines.length && /^(&gt;|>)\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^(&gt;|>)\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${renderInline(quote.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^(\*\s*\*\s*\*|-{3,}|_{3,})\s*$/.test(line.trim())) {
      endList();
      out.push(`<hr class="md-hr" />`);
      i += 1;
      continue;
    }
    const ul = line.match(/^[-*]\s+(.+)$/);
    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (listKind && listKind !== kind) endList();
      listKind = kind;
      listItems.push((ul || ol)?.[1] ?? "");
      i += 1;
      continue;
    }
    endList();
    out.push(line);
    i += 1;
  }
  endList();
  return out.join("\n");
}

export function formatChatText(raw: unknown): string {
  // NUL delimits the fence placeholder below, and stripping it here is what
  // makes that placeholder unforgeable. The old marker was the literal
  // "%%FENCE0%%": escapeHtml does not touch `%`, and the restore was a global
  // UNANCHORED regex, so that string written in prose was replaced by a code
  // block from elsewhere in the same message -- or, with no fence to match,
  // deleted outright by the `|| ""` fallback.
  let s = String(raw ?? "").replace(/\u0000/g, "");
  const fences: string[] = [];
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_: string, code: string) => {
    const id = fences.length;
    fences.push(`<pre class="chat-code">${escapeHtml(code.trim())}</pre>`);
    return `\n\u0000FENCE${id}\u0000\n`;
  });
  s = escapeHtml(s);
  s = renderBlocks(s);
  s = s
    .split("\n")
    .map((line: string) => {
      if (!line) return line;
      if (/^\u0000FENCE\d+\u0000$/.test(line.trim())) return line;
      if (/^<(pre|div|table|ul|ol|h[1-3]|blockquote|hr)\b/i.test(line.trim())) return line;
      return renderInline(line);
    })
    .join("\n");
  // Restore AFTER the inline pass, not before it. Restoring first spliced a
  // MULTI-LINE <pre> into `s`, and the block-tag guard above only ever tested
  // the first line of it -- so every line of a code block after the first went
  // through renderInline, rewriting backticks into <code>, ** into <strong> and
  // bare URLs into <a> INSIDE the <pre>. The first line came out intact and the
  // rest did not, which is what made it look like a rendering glitch.
  s = s.replace(/\u0000FENCE(\d+)\u0000/g, (_: string, id: string) => fences[Number(id)] || "");
  return s;
}
