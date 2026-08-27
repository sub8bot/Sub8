import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "data", "screens");
await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--hide-scrollbars", "--use-angle=metal", "--window-size=900,900"],
  defaultViewport: { width: 900, height: 900, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
await page.goto("http://127.0.0.1:8787/tool.html?v=confused-gap", {
  waitUntil: "domcontentloaded",
  timeout: 15000,
});
await page.waitForSelector("canvas.avatar-canvas", { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1200));

const btn = await page.$('[data-act="face"][data-id="confused"]');
if (btn) await btn.click();
await new Promise((r) => setTimeout(r, 400));

const hero = await page.$(".hero .stage");
for (let i = 1; i <= 3; i++) {
  await new Promise((r) => setTimeout(r, 450));
  await hero.screenshot({ path: path.join(outDir, `confused-${i}.png`) });
}

await browser.close();
console.log("wrote confused frames");
