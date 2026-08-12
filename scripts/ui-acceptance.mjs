#!/usr/bin/env node
/**
 * Two-browser UI acceptance test for the self-hosted collaboration stack.
 *
 * Requires a running stack (see SELFHOST.md "本地开发"):
 *   - frontend dev server  : http://localhost:3001 (yarn start)
 *   - room server          : http://localhost:3002 (docker/room)
 *   - storage backend      : http://localhost:8080 (docker/storage)
 *
 * Requires playwright installed outside the repo, e.g.:
 *   npm install playwright  (in a temp dir), then
 *   $env:PLAYWRIGHT_DIR = "<tempdir>"; node scripts/ui-acceptance.mjs
 *
 * Verifies:
 *   1. A creates a room, B joins via the room link
 *   2. A draws a rectangle -> B receives it (scene sync via WebSocket)
 *   3. A uploads a PNG -> B receives the image automatically (storage sync)
 *   4. transport is websocket (diagnostics) on both clients
 *   5. B reloads -> scene + image recover from storage
 */
import path from "node:path";
import { createRequire } from "node:module";

const PLAYWRIGHT_DIR = process.env.PLAYWRIGHT_DIR;
if (!PLAYWRIGHT_DIR) {
  console.error(
    "Set PLAYWRIGHT_DIR to a directory containing a playwright install (npm i playwright).",
  );
  process.exit(1);
}
const require = createRequire(path.join(PLAYWRIGHT_DIR, "package.json"));
const { chromium } = require("playwright");

const APP_URL = process.env.APP_URL || "http://localhost:3001";

// 1x1 red PNG (valid, tiny)
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

const waitFor = async (fn, timeoutMs = 20000, intervalMs = 250) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

const browser = await chromium.launch({
  executablePath: process.env.BROWSER_PATH || undefined,
  channel: process.env.BROWSER_CHANNEL || undefined,
});
const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();

try {
  // ------------------------------------------------------------------
  console.log("== 1. A creates a collaboration room ==");
  await pageA.goto(APP_URL);
  await pageA.waitForSelector(".excalidraw__canvas.interactive", { timeout: 30000 });
  await pageA.click(".collab-button");
  await pageA.waitForSelector(".ShareDialog", { timeout: 10000 });
  // first picker button = "Start session" (locale-independent)
  await pageA.locator(".ShareDialog__picker__button button").first().click();

  const roomUrl = await waitFor(() => pageA.evaluate(() => location.hash.startsWith("#room=") && location.href));
  check("A created room (URL has #room=)", !!roomUrl, roomUrl || "no hash");
  const roomHash = new URL(roomUrl).hash;

  // close the share dialog so it doesn't cover the canvas
  await pageA.keyboard.press("Escape");
  await pageA.waitForSelector(".ShareDialog", { state: "detached", timeout: 5000 }).catch(() => {});

  // A's diagnostics
  await waitFor(() =>
    pageA.evaluate(() => {
      const d = window.__EXCALIDRAW_DIAG__;
      return d && d.collaborating && d.socketConnected;
    }),
  );
  const diagA = await pageA.evaluate(() => window.__EXCALIDRAW_DIAG__);
  check("A transport = websocket", diagA.transport === "websocket", `got ${diagA.transport}`);
  check("A storage reachable", diagA.storage === "ok", `got ${diagA.storage}`);

  // ------------------------------------------------------------------
  console.log("== 2. B joins the room ==");
  await pageB.goto(roomUrl);
  await pageB.waitForSelector(".excalidraw__canvas.interactive", { timeout: 30000 });
  await waitFor(() =>
    pageB.evaluate(() => {
      const d = window.__EXCALIDRAW_DIAG__;
      return d && d.collaborating && d.socketConnected;
    }),
  );
  const diagB = await pageB.evaluate(() => window.__EXCALIDRAW_DIAG__);
  check("B joined (collaborating)", diagB.collaborating === true);
  check("B transport = websocket", diagB.transport === "websocket", `got ${diagB.transport}`);

  // ------------------------------------------------------------------
  console.log("== 3. A draws a rectangle -> B receives it ==");
  // switch to the rectangle tool (keyboard shortcut "2")
  await pageA.keyboard.press("2");
  const canvas = await pageA.locator(".excalidraw__canvas.interactive").boundingBox();
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await pageA.mouse.move(cx - 150, cy - 100);
  await pageA.mouse.down();
  await pageA.mouse.move(cx + 150, cy + 100, { steps: 10 });
  await pageA.mouse.up();

  const aElements = await pageA.evaluate(() =>
    (window.collab?.excalidrawAPI?.getSceneElements?.() ?? []).map((e) => e.type),
  );
  check(`A created a rectangle locally (types=${JSON.stringify(aElements)})`, aElements.includes("rectangle"));

  const bElements = await waitFor(() =>
    pageB.evaluate(() => {
      const el = window.collab?.excalidrawAPI?.getSceneElements?.() ?? [];
      return el.filter((e) => e.type === "rectangle").length >= 1 ? el.length : 0;
    }),
  );
  check(`B sees A's rectangle (elements=${bElements})`, bElements >= 1);

  // ------------------------------------------------------------------
  console.log("== 4. A uploads a PNG -> B receives it automatically ==");
  await pageA.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "red.png", { type: "image/png" }));
    const canvas = document.querySelector(".excalidraw__canvas.interactive");
    canvas.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  }, PNG_1PX);

  // A: image element inserted and file uploaded (pending -> 0)
  await waitFor(() =>
    pageA.evaluate(() => {
      const d = window.__EXCALIDRAW_DIAG__;
      const el = window.collab?.excalidrawAPI?.getSceneElements?.() ?? [];
      return d && d.filePending === 0 && el.some((e) => e.type === "image" && e.status === "saved") ? true : false;
    }),
  );
  check("A: image uploaded (status=saved, pending=0)", true);

  // B: receives the image element and downloads the file
  const bHasImage = await waitFor(() =>
    pageB.evaluate(() => {
      const el = window.collab?.excalidrawAPI?.getSceneElements?.() ?? [];
      const files = window.collab?.excalidrawAPI?.getFiles?.() ?? {};
      const d = window.__EXCALIDRAW_DIAG__;
      const img = el.find((e) => e.type === "image");
      return d && img && img.status === "saved" && Object.keys(files).length > 0;
    }),
  );
  check("B: image element + file received without manual refresh", !!bHasImage);

  // ------------------------------------------------------------------
  console.log("== 5. B reloads -> scene + image recover from storage ==");
  await pageB.reload();
  await pageB.waitForSelector(".excalidraw__canvas.interactive", { timeout: 30000 });
  await waitFor(() =>
    pageB.evaluate(() => {
      const d = window.__EXCALIDRAW_DIAG__;
      const el = window.collab?.excalidrawAPI?.getSceneElements?.() ?? [];
      const files = window.collab?.excalidrawAPI?.getFiles?.() ?? {};
      return d && d.collaborating && el.some((e) => e.type === "image") && Object.keys(files).length > 0;
    }),
  );
  check("B after reload: scene + image recovered", true);

  const diagB2 = await pageB.evaluate(() => window.__EXCALIDRAW_DIAG__);
  check("B after reload: transport still websocket", diagB2.transport === "websocket", `got ${diagB2.transport}`);

  // ------------------------------------------------------------------
  console.log("");
  console.log(`ui-acceptance: ${passed} passed, ${failed} failed`);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
