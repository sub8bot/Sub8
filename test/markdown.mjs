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

console.log("ok markdown");
