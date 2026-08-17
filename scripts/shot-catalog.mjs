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
  args: ["--hide-scrollbars", "--use-angle=metal", "--window-size=1400,1600"],
  defaultViewport: { width: 1400, height: 1600, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
page.on("pageerror", (err) => console.error("pageerror", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("console", msg.text());
});

await page.goto("http://127.0.0.1:8787/tool.html?v=no-front-leg", {
  waitUntil: "domcontentloaded",
  timeout: 15000,
});
await page.waitForSelector("canvas.avatar-canvas", { timeout: 15000 });
await page.waitForFunction(() => document.querySelectorAll("canvas.avatar-canvas").length >= 3);
await new Promise((r) => setTimeout(r, 1500));

const hero = await page.$(".hero .stage");
await hero.screenshot({ path: path.join(outDir, "octo-hero.png") });
await page.screenshot({ path: path.join(outDir, "octo-catalog.png"), fullPage: false });

const happy = await page.$('[data-act="face"][data-id="happy"]');
if (happy) await happy.click();
for (const hex of ["#b06dd1", "#9b6dd1", "#c56dd1", "#7d6dd1"]) {
  const swatch = await page.$(`[data-act="color"][data-id="${hex}"]`);
  if (swatch) await swatch.click();
  await new Promise((r) => setTimeout(r, 500));
  await hero.screenshot({ path: path.join(outDir, `octo-hero-${hex.slice(1)}.png`) });
}
const motions = await page.$("#motions");
if (motions) await motions.screenshot({ path: path.join(outDir, "octo-motions.png") });
await page.screenshot({ path: path.join(outDir, "octo-catalog-pink.png"), fullPage: true });

await browser.close();
console.log("wrote shots to", outDir);
