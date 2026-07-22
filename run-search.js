/**
 * One-shot flow:
 *  1. Starts normal Chrome (not Playwright-launched) with remote debugging
 *  2. You log into x.com in that window
 *  3. Script detects session, runs search, prints counts
 *
 * Usage:  npm start
 */

import { chromium } from "playwright";
import { spawn } from "child_process";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import http from "http";
import net from "net";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SEARCH_QUERY = process.env.SEARCH_QUERY || "$weat min_faves:100";
const DAYS = Number(process.env.DAYS || 60);
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 80);
const SCROLL_PAUSE_MS = Number(process.env.SCROLL_PAUSE_MS || 1500);
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 900000); // 15 min
const PROFILE_DIR =
  process.env.PROFILE_DIR || join(__dirname, "chrome-manual-profile");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
].filter(Boolean);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  throw new Error("Google Chrome not found. Set CHROME_PATH.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function waitForCdp(port, timeoutMs = 30000) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpGet(url);
      if (r.status === 200) return JSON.parse(r.body);
    } catch {
      // keep trying
    }
    await sleep(300);
  }
  throw new Error(`CDP not ready on port ${port}`);
}

function sinceDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function buildSearchUrl(query, days) {
  const since = sinceDate(days);
  const full = `${query} since:${since}`;
  return {
    url: `https://x.com/search?q=${encodeURIComponent(full)}&src=typed_query&f=live`,
    fullQuery: full,
    since,
  };
}

async function hasAuthCookie(context) {
  try {
    const cookies = await context.cookies("https://x.com");
    return cookies.some(
      (c) =>
        (c.name === "auth_token" || c.name === "ct0") &&
        c.value &&
        c.value.length > 10
    );
  } catch {
    return false;
  }
}

async function dumpDebug(page, label) {
  try {
    const dir = join(__dirname, "debug");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `${label}.png`), fullPage: false });
    writeFileSync(join(dir, `${label}.html`), await page.content(), "utf8");
    console.log("Debug:", join(dir, `${label}.png`));
  } catch (e) {
    console.warn("debug save failed:", e.message);
  }
}

async function collectFromPage(page) {
  return page.evaluate(() => {
    const found = [];
    for (const article of document.querySelectorAll(
      'article[data-testid="tweet"]'
    )) {
      const statusLink = article.querySelector('a[href*="/status/"]');
      if (!statusLink) continue;
      const href = statusLink.getAttribute("href") || "";
      const m = href.match(/\/([^/?#]+)\/status\/(\d+)/);
      if (!m) continue;
      let author = m[1].toLowerCase();
      const statusId = m[2];
      const userLink = article.querySelector(
        'div[data-testid="User-Name"] a[href^="/"]'
      );
      if (userLink) {
        const uh = (userLink.getAttribute("href") || "")
          .replace(/^\//, "")
          .split(/[?#]/)[0];
        if (uh && !uh.includes("/")) author = uh.toLowerCase();
      }
      found.push({ statusId, author });
    }
    return found;
  });
}

function clearLocks(profileDir) {
  try {
    for (const name of readdirSync(profileDir)) {
      if (name.startsWith("Singleton") || name === "Lockfile") {
        try {
          unlinkSync(join(profileDir, name));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

async function main() {
  const chromePath = findChrome();
  mkdirSync(PROFILE_DIR, { recursive: true });
  clearLocks(PROFILE_DIR);

  const port = await getFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;

  console.log("Starting Chrome (normal process, you will log in)...");
  console.log("  Chrome: ", chromePath);
  console.log("  Profile:", PROFILE_DIR);
  console.log("  CDP:    ", cdpUrl);
  console.log("");

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "https://x.com/home",
  ];

  // On Windows, chrome.exe often spawns the real browser and the
  // launcher PID exits (code 0). Track CDP health, not that PID.
  const chrome = spawn(chromePath, chromeArgs, {
    stdio: "ignore",
    windowsHide: false,
    detached: true, // survive even if our bookkeeping process ends early
  });
  chrome.unref();

  chrome.on("error", (err) => {
    console.error("Failed to start Chrome:", err.message);
  });

  try {
    await waitForCdp(port);
    console.log("Chrome is up. Connecting...");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  async function cdpAlive() {
    try {
      const r = await httpGet(`http://127.0.0.1:${port}/json/version`, 1500);
      return r.status === 200;
    } catch {
      return false;
    }
  }

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No browser context");

  let page =
    context.pages().find((p) => {
      const u = p.url();
      return u && !u.startsWith("devtools:");
    }) ||
    context.pages()[0] ||
    (await context.newPage());

  // Wait for manual login
  if (!(await hasAuthCookie(context))) {
    console.log("======================================================");
    console.log("  Log into x.com in the Chrome window that opened.");
    console.log("  (Title often includes the profile path or is a");
    console.log("   fresh x.com window — not your everyday Chrome.)");
    console.log("  Leave it open. This script continues when it sees");
    console.log("  your session cookie.");
    console.log("======================================================");
    console.log("");

    const deadline = Date.now() + LOGIN_WAIT_MS;
    let n = 0;
    while (Date.now() < deadline) {
      if (!(await cdpAlive())) {
        throw new Error(
          "Chrome debug port closed (window was closed?). Re-run: npm start"
        );
      }
      if (await hasAuthCookie(context)) {
        console.log("Login detected.");
        break;
      }
      n += 1;
      if (n % 10 === 0) {
        const mins = Math.round((deadline - Date.now()) / 60000);
        console.log(`Still waiting for login... (~${mins} min left)`);
      }
      await sleep(2000);
    }

    if (!(await hasAuthCookie(context))) {
      await dumpDebug(page, "login-timeout");
      throw new Error("Timed out waiting for login.");
    }
  } else {
    console.log("Already logged in (saved session).");
  }

  const { url, fullQuery, since } = buildSearchUrl(SEARCH_QUERY, DAYS);
  console.log("Opening search:", fullQuery);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(3500);

  await page
    .locator('article[data-testid="tweet"], [data-testid="emptyState"]')
    .first()
    .waitFor({ timeout: 25000 })
    .catch(() => {});

  let articles = await page.locator('article[data-testid="tweet"]').count();
  console.log(`Initial tweet articles visible: ${articles}`);

  if (articles === 0) {
    await dumpDebug(page, "no-tweets");
    const topUrl = url.replace("f=live", "f=top");
    console.log("Trying Top tab...");
    await page.goto(topUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3500);
    articles = await page.locator('article[data-testid="tweet"]').count();
    console.log(`Top tab articles: ${articles}`);
  }

  const byId = new Map();
  let stagnant = 0;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    const batch = await collectFromPage(page);
    const before = byId.size;
    for (const item of batch) {
      if (!byId.has(item.statusId)) byId.set(item.statusId, item.author);
    }
    const after = byId.size;
    const gained = after - before;
    console.log(
      `Scroll ${i + 1}/${MAX_SCROLLS}: +${gained} new (total posts=${after})`
    );

    if (gained === 0) {
      stagnant += 1;
      if (stagnant >= 4) {
        console.log("No new posts for several scrolls — stopping.");
        break;
      }
    } else {
      stagnant = 0;
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
    await sleep(SCROLL_PAUSE_MS);
  }

  const posts = [...byId.entries()].map(([statusId, author]) => ({
    statusId,
    author,
  }));
  const accounts = new Set(posts.map((p) => p.author));

  const summary = {
    query: SEARCH_QUERY,
    fullQuery,
    since,
    days: DAYS,
    postCount: posts.length,
    distinctAccounts: accounts.size,
    accounts: [...accounts].sort(),
    scrapedAt: new Date().toISOString(),
  };

  console.log("\n========== RESULTS ==========");
  console.log(`Query:              ${summary.fullQuery}`);
  console.log(`Posts (loaded):     ${summary.postCount}`);
  console.log(`Distinct accounts:  ${summary.distinctAccounts}`);
  console.log("=============================\n");

  writeFileSync(
    join(__dirname, "last-results.json"),
    JSON.stringify({ ...summary, posts }, null, 2),
    "utf8"
  );
  console.log("Saved: last-results.json");

  if (posts.length === 0) await dumpDebug(page, "zero-results");

  // Disconnect Playwright only; leave Chrome open so session stays warm
  await browser.close().catch(() => {});
  console.log("Done. You can close the Chrome window when finished.");
  // Do not kill chrome process — user may want to inspect
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
