/**
 * Scrape tweets from a user via X search.
 * Captures text, media, and reply metadata; optionally resolves parent tweets.
 */
import { sleep } from "./chrome.js";
import { sinceDate } from "./periods.js";
import { extractCashtags, extractTickersFromOcr, extractSymbolMapFromText } from "./extract.js";
import { enrichTweetsWithImageOcr } from "./image-ocr.js";

export function normalizeHandle(input) {
  if (!input) throw new Error("Account required");
  let s = String(input).trim();
  s = s.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "");
  s = s.replace(/^@/, "");
  s = s.split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) {
    throw new Error(`Invalid handle: ${input}`);
  }
  return s;
}

/**
 * Build X advanced search URL.
 * @param {string} handle
 * @param {object} options
 * @param {number} [options.days] — lookback days from today (legacy)
 * @param {string} [options.since] — YYYY-MM-DD inclusive
 * @param {string} [options.until] — YYYY-MM-DD exclusive (X until: operator)
 */
export function buildUserSearchUrl(handle, options = {}) {
  let since = options.since;
  let until = options.until || null;
  if (!since && options.days != null) {
    since = sinceDate(options.days);
  }
  if (!since) since = sinceDate(30);

  let q = `from:${handle} since:${since}`;
  if (until) q += ` until:${until}`;
  return {
    url: `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`,
    query: q,
    since,
    until,
  };
}

function collectMedia(root) {
  const media = [];
  const imgs = root.querySelectorAll(
    'img[src*="pbs.twimg.com/media"], img[src*="pbs.twimg.com/ext_tw_video_thumb"]'
  );
  for (const img of imgs) {
    let src = img.getAttribute("src") || "";
    if (!src) continue;
    src = src.replace(/&name=\w+/, "&name=large");
    if (!src.includes("name=")) {
      src += (src.includes("?") ? "&" : "?") + "name=large";
    }
    media.push({ src, alt: img.getAttribute("alt") || "" });
  }
  return media;
}

/**
 * Collect tweets currently rendered on the page (text + media + reply flags).
 */
async function collectFromPage(page, handle) {
  const h = handle.toLowerCase();
  return page.evaluate((expectedHandle) => {
    function collectMediaLocal(root) {
      const media = [];
      const imgs = root.querySelectorAll(
        'img[src*="pbs.twimg.com/media"], img[src*="pbs.twimg.com/ext_tw_video_thumb"]'
      );
      for (const img of imgs) {
        let src = img.getAttribute("src") || "";
        if (!src) continue;
        src = src.replace(/&name=\w+/, "&name=large");
        if (!src.includes("name=")) {
          src += (src.includes("?") ? "&" : "?") + "name=large";
        }
        media.push({ src, alt: img.getAttribute("alt") || "" });
      }
      return media;
    }

    const found = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];
      let main = null;
      for (const a of statusLinks) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/([^/?#]+)\/status\/(\d+)/);
        if (!m) continue;
        if (m[1].toLowerCase() === expectedHandle) {
          main = { author: m[1].toLowerCase(), statusId: m[2], href };
          break;
        }
      }
      if (!main) continue;

      let text = "";
      const textEl = article.querySelector('[data-testid="tweetText"]');
      if (textEl) text = textEl.innerText || textEl.textContent || "";

      let createdAt = null;
      const timeEl = article.querySelector("time");
      if (timeEl) createdAt = timeEl.getAttribute("datetime") || null;

      const media = collectMediaLocal(article);

      // Reply detection
      const social =
        article.querySelector('[data-testid="socialContext"]')?.innerText ||
        "";
      const isReply =
        /replied|replying to/i.test(social) ||
        !!article.querySelector('a[href*="/status/"][href*="status"]') &&
          /Replying to/i.test(article.innerText.slice(0, 200));

      // Try to find parent status id from "show this thread" / conversation links
      let parentStatusId = null;
      // aria or text "Replying to"
      const replyLabel = article.innerText.match(
        /Replying to[^\n]*\n?/i
      );
      // Links that aren't this tweet
      for (const a of statusLinks) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/([^/?#]+)\/status\/(\d+)/);
        if (!m) continue;
        if (m[2] !== main.statusId) {
          // Heuristic: first other status link may be parent in some layouts
          // Prefer links above the tweet text
          parentStatusId = parentStatusId || m[2];
        }
      }

      found.push({
        statusId: main.statusId,
        author: main.author,
        text: text.trim(),
        createdAt,
        url: `https://x.com/${main.author}/status/${main.statusId}`,
        media,
        hasMedia: media.length > 0,
        isReply: !!isReply || /Replying to/i.test(article.innerText.slice(0, 120)),
        replySocial: social || null,
        parentStatusId,
      });
    }
    return found;
  }, h);
}

/**
 * For replies with no local symbols, open the status page and read the parent tweet.
 */
export async function resolveParentTweets(page, tweets, options = {}) {
  const maxParents = options.maxParents ?? 40;
  let resolved = 0;

  const needsParent = tweets.filter((t) => {
    if (!t.isReply && !t.parentStatusId) return false;
    const hasTextSym =
      extractCashtags(t.text || "").length > 0 ||
      extractSymbolMapFromText(t.text || "").size > 0;
    const hasImg =
      (t.media?.length > 0 || t.hasMedia) &&
      (t.imageOcr || t.chartTickers?.length);
    const hasImgSym =
      extractTickersFromOcr(t.imageOcr || "").length > 0 ||
      (t.chartTickers || []).length > 0;
    return !hasTextSym && !hasImgSym;
  });

  console.log(
    `Parent resolve: ${needsParent.length} replies need parent context (cap ${maxParents})`
  );

  for (const t of needsParent) {
    if (resolved >= maxParents) break;
    try {
      const url = t.url;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(2500);

      const parent = await page.evaluate((childId) => {
        const articles = [
          ...document.querySelectorAll('article[data-testid="tweet"]'),
        ];
        // Parent is usually the first article that is NOT the child
        for (const article of articles) {
          const link = article.querySelector('a[href*="/status/"]');
          if (!link) continue;
          const href = link.getAttribute("href") || "";
          const m = href.match(/\/([^/?#]+)\/status\/(\d+)/);
          if (!m) continue;
          if (m[2] === childId) continue;

          let text = "";
          const textEl = article.querySelector('[data-testid="tweetText"]');
          if (textEl) text = textEl.innerText || textEl.textContent || "";

          const media = [];
          for (const img of article.querySelectorAll(
            'img[src*="pbs.twimg.com/media"]'
          )) {
            let src = img.getAttribute("src") || "";
            if (!src) continue;
            src = src.replace(/&name=\w+/, "&name=large");
            if (!src.includes("name="))
              src += (src.includes("?") ? "&" : "?") + "name=large";
            media.push({ src, alt: img.getAttribute("alt") || "" });
          }

          let createdAt = null;
          const timeEl = article.querySelector("time");
          if (timeEl) createdAt = timeEl.getAttribute("datetime");

          return {
            parentStatusId: m[2],
            parentAuthor: m[1],
            parentText: text.trim(),
            parentMedia: media,
            parentCreatedAt: createdAt,
            parentUrl: `https://x.com/${m[1]}/status/${m[2]}`,
          };
        }
        return null;
      }, t.statusId);

      if (parent) {
        Object.assign(t, parent);
        t.isReply = true;
        t.parentStatusId = parent.parentStatusId;
        resolved += 1;
        console.log(
          `  Parent for ${t.statusId} → ${parent.parentStatusId} (${(parent.parentText || "").slice(0, 60).replace(/\n/g, " ")})`
        );
      }
    } catch (e) {
      console.warn(`  Parent resolve failed ${t.statusId}: ${e.message}`);
    }
  }

  // OCR parent images
  const withParentMedia = tweets.filter((t) => t.parentMedia?.length);
  if (withParentMedia.length && options.skipParentOcr !== true) {
    // Temporarily map parent media into media field for OCR helper
    const clones = withParentMedia.map((t) => ({
      ...t,
      statusId: `parent_${t.parentStatusId || t.statusId}`,
      media: t.parentMedia,
      hasMedia: true,
      text: t.parentText || "",
    }));
    await enrichTweetsWithImageOcr(clones, {
      maxImages: options.maxParentOcrImages ?? 30,
      forceAllMedia: true,
    });
    for (const c of clones) {
      const childId = c.statusId.replace(/^parent_/, "");
      // find original tweet by parentStatusId
      const orig = tweets.find(
        (t) =>
          t.parentStatusId === childId ||
          `parent_${t.parentStatusId}` === c.statusId
      );
      if (orig) {
        orig.parentImageOcr = c.imageOcr || null;
        orig.parentChartTickers = c.chartTickers || [];
      }
    }
  }

  console.log(`Parent resolve done (${resolved} parents).`);
  return tweets;
}

/**
 * Scroll search results and collect unique tweets.
 */
export async function scrapeUserTweets(page, handle, options = {}) {
  const days = options.days ?? 30;
  const maxScrolls = options.maxScrolls ?? 100;
  const scrollPauseMs = options.scrollPauseMs ?? 1500;
  const { url, query, since, until } = buildUserSearchUrl(handle, {
    days: options.since || options.until ? undefined : days,
    since: options.since,
    until: options.until,
  });

  console.log("Opening timeline search:", query);
  console.log("URL:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(3500);

  await page
    .locator('article[data-testid="tweet"], [data-testid="emptyState"]')
    .first()
    .waitFor({ timeout: 25000 })
    .catch(() => {});

  const byId = new Map();
  let stagnant = 0;

  for (let i = 0; i < maxScrolls; i++) {
    const batch = await collectFromPage(page, handle);
    const before = byId.size;
    for (const t of batch) {
      const prev = byId.get(t.statusId);
      if (!prev) byId.set(t.statusId, t);
      else {
        if ((t.media?.length || 0) > (prev.media?.length || 0)) {
          byId.set(t.statusId, { ...prev, ...t });
        } else if ((t.text || "").length > (prev.text || "").length) {
          byId.set(t.statusId, { ...prev, text: t.text, isReply: t.isReply || prev.isReply });
        }
      }
    }
    const gained = byId.size - before;
    console.log(
      `Scroll ${i + 1}/${maxScrolls}: +${gained} (total ${byId.size})`
    );

    if (gained === 0) {
      stagnant += 1;
      if (stagnant >= 5) {
        console.log("No new tweets — stopping scroll.");
        break;
      }
    } else {
      stagnant = 0;
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.6));
    await sleep(scrollPauseMs);
  }

  let tweets = [...byId.values()].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  // Client-side date filter for batch windows (X search can be loose)
  if (options.since || options.untilInclusive) {
    const startMs = options.since
      ? Date.parse(options.since + "T00:00:00.000Z")
      : 0;
    const endMs = options.untilInclusive
      ? Date.parse(options.untilInclusive + "T23:59:59.999Z")
      : Infinity;
    const before = tweets.length;
    tweets = tweets.filter((t) => {
      if (!t.createdAt) return true;
      const ms = Date.parse(t.createdAt);
      return ms >= startMs && ms <= endMs;
    });
    if (tweets.length !== before) {
      console.log(
        `  Date filter ${options.since || "…"}..${options.untilInclusive || "…"}: ${before} → ${tweets.length}`
      );
    }
  }

  return {
    tweets,
    query,
    since,
    until: until || null,
    days: options.days ?? days,
    handle,
  };
}
