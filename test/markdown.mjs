import assert from "node:assert/strict";
import { formatChatText } from "../web/markdown.js";

const bold = formatChatText("Hello **world**");
assert.match(bold, /<strong>world<\/strong>/);

const link = formatChatText("see [Kayak](https://www.kayak.com) please");
assert.match(link, /href="https:\/\/www.kayak.com"/);
assert.match(link, />Kayak<\/a>/);

const table = formatChatText(`**SFO → IAD**

| Flight | Route | Price |
|---|---|---|
| Frontier | SFO–BWI, 1 stop | $265 |
| United | SFO–IAD, nonstop | $579 |
`);
assert.match(table, /<table class="md-table">/);
assert.match(table, /<th>Flight<\/th>/);
assert.match(table, /<td>United<\/td>/);
assert.match(table, /<strong>SFO → IAD<\/strong>/);
assert.doesNotMatch(table, /\|---/);

const fence = formatChatText("use\n```\n<a>\n```\nok");
assert.match(fence, /<pre class="chat-code">&lt;a&gt;<\/pre>/);

const list = formatChatText("- one\n- two");
assert.match(list, /<ul class="md-list">/);
assert.match(list, /<li>one<\/li>/);

// A fenced block used to be restored into `s` BEFORE the inline pass, and the
// block-tag guard there only tested the FIRST line of the multi-line <pre>. So
// every code line after the first was run through renderInline: backticks
// became <code>, ** became <strong>, bare URLs became <a> -- inside the <pre>.
// The first line came out intact and the rest did not.
const fenced = formatChatText(
  "```js\n" +
    "const key = process.env.API_KEY;\n" +
    "const url = `https://api.example.com/v1/${id}`;\n" +
    "// see https://docs.example.com/guide for details\n" +
    "```",
);
assert.match(fenced, /<pre class="chat-code">/);
assert.doesNotMatch(fenced, /<code>/, "a backtick inside a code block became <code>");
assert.doesNotMatch(fenced, /<a /, "a URL inside a code block became a link");
assert.doesNotMatch(fenced, /<strong>/, "** inside a code block became bold");
// The content is all still there, escaped.
assert.match(fenced, /process\.env\.API_KEY/);
assert.match(fenced, /https:\/\/docs\.example\.com\/guide/);

const shellFence = formatChatText("```bash\ncp *.log /tmp/\necho \"a**b**c\"\n```");
assert.doesNotMatch(shellFence, /<strong>/, "** inside a bash block became bold");

// The fence placeholder used to be the literal "%%FENCE0%%". escapeHtml does
// not touch `%`, and the restore was a global unanchored regex, so that string
// in ordinary prose was replaced by a code block from elsewhere in the message
// -- or deleted outright when there was no fence to match.
const sentinel = formatChatText("Deploy notes:\n\n%%FENCE0%% is the sentinel\n\n```\nfoo\n```");
assert.equal((sentinel.match(/<pre class="chat-code">/g) || []).length, 1, "the code block was rendered twice");
assert.match(sentinel, /%%FENCE0%% is the sentinel/, "the literal text was replaced by a code block");

const lonely = formatChatText("hello %%FENCE0%% world");
assert.match(lonely, /hello %%FENCE0%% world/, "the literal text was silently deleted");

// Bold wrapping a sentence that ends in a URL + `:**`. Autolink used to eat the
// closing `**`, so </strong> landed inside href and the rest of the message
// (every following line in the same bubble) stayed bold.
const boldUrl = formatChatText(
  "**Live on https://freebots.lol/media:**\n- **u/voltgarden** — ok\nplain after",
);
assert.match(boldUrl, /<strong>Live on <a href="https:\/\/freebots\.lol\/media"/);
assert.match(boldUrl, /<strong>u\/voltgarden<\/strong>/);
assert.match(boldUrl, /plain after/);
assert.equal((boldUrl.match(/<strong>/g) || []).length, (boldUrl.match(/<\/strong>/g) || []).length);
assert.doesNotMatch(boldUrl, /href="[^"]*<\/strong>/);

const boldBareUrl = formatChatText("**https://example.com/path**");
assert.match(boldBareUrl, /<strong><a href="https:\/\/example.com\/path"/);
assert.match(boldBareUrl, /<\/a><\/strong>/);

// NUL is the new delimiter, so it is stripped from input; a pasted NUL must not
// be able to forge a placeholder.
const forged = formatChatText("hi \u0000FENCE0\u0000 there\n\n```\nreal\n```");
assert.equal((forged.match(/<pre class="chat-code">/g) || []).length, 1, "a forged placeholder produced a code block");
assert.match(forged, /real/);

console.log("ok markdown");
