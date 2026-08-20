export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitRow(line) {
  let t = String(line || "").trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function isTableRow(line) {
  const t = String(line || "").trim();
  return t.startsWith("|") && t.includes("|", 1);
}

function isSepRow(line) {
  if (!isTableRow(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/\s/g, "")));
}

function renderInline(s) {
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noreferrer">$1</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)(?=$|[\s)])/g, `$1<a href="$2" target="_blank" rel="noreferrer">$2</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=$|[^\w*])/g, "$1<em>$2</em>");
  return s;
}

function tableHtml(header, rows) {
  const th = header.map((c) => `<th>${renderInline(c)}</th>`).join("");
  const body = rows
    .filter((r) => r.some((c) => c))
    .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function flushList(kind, items) {
  if (!items.length) return "";
  const tag = kind === "ol" ? "ol" : "ul";
  return `<${tag} class="md-list">${items.map((t) => `<li>${renderInline(t)}</li>`).join("")}</${tag}>`;
}

function renderBlocks(s) {
  const lines = String(s).split("\n");
  const out = [];
  let i = 0;
  let listKind = null;
  let listItems = [];
  const endList = () => {
    if (listKind) {
      out.push(flushList(listKind, listItems));
      listKind = null;
      listItems = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      endList();
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i]) && !isSepRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(tableHtml(header, rows));
      continue;
    }
    const fence = line.match(/^%%FENCE(\d+)%%$/);
    if (fence) {
      endList();
      out.push(line);
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      endList();
      const n = heading[1].length;
      out.push(`<h${n} class="md-h">${renderInline(heading[2])}</h${n}>`);
      i += 1;
      continue;
    }
    if (/^(&gt;|>)\s?/.test(line)) {
      endList();
      const quote = [];
      while (i < lines.length && /^(&gt;|>)\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^(&gt;|>)\s?/, ""));
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
      listItems.push((ul || ol)[1]);
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

export function formatChatText(raw) {
  let s = String(raw ?? "");
  const fences = [];
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
    const id = fences.length;
    fences.push(`<pre class="chat-code">${escapeHtml(code.trim())}</pre>`);
    return `\n%%FENCE${id}%%\n`;
  });
  s = escapeHtml(s);
  s = renderBlocks(s);
  s = s.replace(/%%FENCE(\d+)%%/g, (_, id) => fences[Number(id)] || "");
  s = s
    .split("\n")
    .map((line) => {
      if (!line) return line;
      if (/^<(pre|div|table|ul|ol|h[1-3]|blockquote|hr)\b/i.test(line.trim())) return line;
      return renderInline(line);
    })
    .join("\n");
  return s;
}
