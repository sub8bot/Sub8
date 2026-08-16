import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "brand");
await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--hide-scrollbars", "--use-angle=metal", "--allow-file-access-from-files"],
  defaultViewport: { width: 2048, height: 2048, deviceScaleFactor: 1 },
});

const page = await browser.newPage();
page.on("pageerror", (err) => console.error("pageerror", err.message));
await page.goto("http://127.0.0.1:8787/logo.html?size=2048&color=%23b06dd1&face=happy", {
  waitUntil: "networkidle0",
  timeout: 20000,
});
await page.waitForFunction(() => window.__logoReady === true, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 400));
const canvas = await page.$("canvas");
if (!canvas) throw new Error("no canvas");
await canvas.screenshot({
  path: path.join(outDir, "octobot-logo.png"),
  omitBackground: true,
});
await browser.close();
console.log("wrote", path.join(outDir, "octobot-logo.png"));
