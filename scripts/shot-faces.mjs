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
  args: ["--hide-scrollbars", "--use-angle=metal", "--window-size=1400,2400"],
  defaultViewport: { width: 1400, height: 2400, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
await page.goto("http://127.0.0.1:8787/tool.html?v=audit-faces2", {
  waitUntil: "domcontentloaded",
  timeout: 15000,
});
await page.waitForSelector("canvas.avatar-canvas", { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1600));



const faces = await page.$("#faces");
if (faces) await faces.screenshot({ path: path.join(outDir, "octo-faces-audit2.png") });
await page.screenshot({ path: path.join(outDir, "octo-catalog-pink.png"), fullPage: true });

await browser.close();
console.log("wrote face audit");
