/**
 * Attach to a Chrome YOU already started (and logged into).
 * Does NOT launch the browser and does NOT log in.
 *
 * Setup:
 *   1. npm run start-chrome
 *   2. Log into x.com in that Chrome window
 *   3. npm run search
 *
 * Env:
 *   SEARCH_QUERY    default: $weat min_faves:100
 *   DAYS            default: 60
 *   MAX_SCROLLS     default: 80
 *   SCROLL_PAUSE_MS default: 1500
 *   CDP_URL         default: http://127.0.0.1:9222
 */

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";
const SEARCH_QUERY = process.env.SEARCH_QUERY || "$weat min_faves:100";
const DAYS = Number(process.env.DAYS || 60);
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 80);
const SCROLL_PAUSE_MS = Number(process.env.SCROLL_PAUSE_MS || 1500);

function sinceDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function buildSearchUrl(query, days) {
  const since = sinceDate(days);
  const full = `${query} since:${since}`;
  const q = encodeURIComponent(full);
  return {
    url: `https://x.com/search?q=${q}&src=typed_query&f=live`,
    fullQuery: full,
    since,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    const shot = join(dir, `${label}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    writeFileSync(join(dir, `${label}.html`), await page.content(), "utf8");
    console.log(`Debug saved: ${shot}`);
  } catch (e) {
    console.warn("Could not save debug artifacts:", e.message);
  }
}

async function collectFromPage(page) {
  return page.evaluate(() => {
    const found = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    for (const article of articles) {
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

async function connectBrowser() {
  console.log("Connecting to your Chrome via CDP:", CDP_URL);
  try {
    return await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error("\nCould not connect to Chrome.");
    console.error("Do this first:");
    console.error("  1. npm run start-chrome");
    console.error("  2. Log into x.com in that window");
    console.error("  3. Leave Chrome open, then re-run: npm run search\n");
    console.error(String(err.message || err));
    process.exit(1);
  }
}

async function main() {
  const { url, fullQuery, since } = buildSearchUrl(SEARCH_QUERY, DAYS);

  const browser = await connectBrowser();
  const context = browser.contexts()[0];
  if (!context) {
    console.error("No browser context found. Is Chrome still open?");
    process.exit(1);
  }

  // Prefer an existing normal tab; open one if needed
  let page =
    context.pages().find((p) => {
      const u = p.url();
      return u && !u.startsWith("devtools:") && u !== "about:blank";
    }) ||
    context.pages()[0] ||
    (await context.newPage());

  const authed = await hasAuthCookie(context);
  console.log("Auth cookie present:", authed);
  if (!authed) {
    console.warn(
      "\nWARNING: No x.com auth cookie yet. Log in in the Chrome window,\n" +
        "then re-run npm run search. (Do not close Chrome.)\n"
    );
    await page.goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }).catch(() => {});
    await dumpDebug(page, "not-logged-in");
    // Disconnect only — leave Chrome running for you to log in
    await browser.close().catch(() => {});
    process.exit(2);
  }

  console.log("Opening search:", fullQuery);
  console.log("URL:", url);
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
    console.log("No tweets on Latest — trying Top tab");
    await page.goto(topUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(3500);
    articles = await page.locator('article[data-testid="tweet"]').count();
    console.log(`Top tab tweet articles visible: ${articles}`);
    if (articles === 0) await dumpDebug(page, "no-tweets-top");
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
    mode: "connectOverCDP",
    postCount: posts.length,
    distinctAccounts: accounts.size,
    accounts: [...accounts].sort(),
    scrapedAt: new Date().toISOString(),
    note:
      "Counts are from posts loaded in the timeline (scroll-based). Treat as lower bound if the feed was still growing near the end.",
  };

  console.log("\n========== RESULTS ==========");
  console.log(`Query:              ${summary.fullQuery}`);
  console.log(`Posts (loaded):     ${summary.postCount}`);
  console.log(`Distinct accounts:  ${summary.distinctAccounts}`);
  console.log("=============================\n");

  const outPath = join(__dirname, "last-results.json");
  writeFileSync(
    outPath,
    JSON.stringify({ ...summary, posts }, null, 2),
    "utf8"
  );
  console.log("Saved detail to:", outPath);

  if (posts.length === 0) {
    await dumpDebug(page, "zero-results");
  }

  // Disconnect only — do NOT close your Chrome window
  await browser.close().catch(() => {});
  console.log("Done (Chrome left open).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
