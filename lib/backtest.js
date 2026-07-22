/**
 * Backtest recommendations using Yahoo Finance chart API (no API key).
 */
import { toYahooSymbol } from "./extract.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toUnix(d) {
  return Math.floor(new Date(d).getTime() / 1000);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayKey(tsSec) {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

/**
 * Fetch daily closes for symbol between start and end (inclusive padding).
 */
export async function fetchDailyCloses(symbol, startDate, endDate) {
  const period1 = toUnix(startDate) - 7 * 86400;
  const period2 = toUnix(endDate) + 7 * 86400;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=${period1}&period2=${period2}&events=history`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol}: no data`);
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const map = new Map();
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || Number.isNaN(c)) continue;
    map.set(dayKey(ts[i]), c);
  }
  return map;
}

function priceOnOrAfter(closesMap, dateStr) {
  // exact or next available up to +10 calendar days
  for (let i = 0; i <= 10; i++) {
    const k = addDays(dateStr, i);
    if (closesMap.has(k)) return { date: k, price: closesMap.get(k) };
  }
  return null;
}

function priceOnOrBefore(closesMap, dateStr) {
  for (let i = 0; i <= 10; i++) {
    const k = addDays(dateStr, -i);
    if (closesMap.has(k)) return { date: k, price: closesMap.get(k) };
  }
  return null;
}

/**
 * @param {Array} recommendations - with ticker, direction, createdAt
 * @param {number} holdDays - holding period for exit
 */
export async function backtestRecommendations(recommendations, holdDays) {
  // Only *obvious* long/short with dates (skip weak/ambiguous sides)
  const tradeable = recommendations.filter(
    (r) =>
      r.directionObvious &&
      (r.direction === "long" || r.direction === "short") &&
      r.createdAt &&
      r.ticker
  );

  const byTicker = new Map();
  for (const r of tradeable) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }

  const results = [];
  const errors = [];

  for (const [ticker, recs] of byTicker) {
    const yahoo = toYahooSymbol(ticker);
    const dates = recs.map((r) => r.createdAt.slice(0, 10)).sort();
    const start = dates[0];
    const end = addDays(dates[dates.length - 1], holdDays + 15);
    let closes;
    try {
      closes = await fetchDailyCloses(yahoo, start, end);
      await sleep(200); // be polite to Yahoo
    } catch (e) {
      errors.push({ ticker, yahoo, error: e.message });
      for (const r of recs) {
        results.push({
          ...r,
          yahooSymbol: yahoo,
          status: "no_price_data",
          error: e.message,
        });
      }
      continue;
    }

    const today = new Date().toISOString().slice(0, 10);

    for (const r of recs) {
      const entryDay = r.createdAt.slice(0, 10);
      const entry = priceOnOrAfter(closes, entryDay);
      if (!entry) {
        results.push({ ...r, status: "no_entry_price" });
        continue;
      }
      const targetExit = addDays(entry.date, holdDays);
      const horizonComplete = targetExit <= today;

      // Prefer close on/after target; if horizon still open or future, mark-to-market
      let exitPx = priceOnOrAfter(closes, targetExit);
      let status = "ok";
      if (!exitPx && !horizonComplete) {
        // latest available close on or before today
        exitPx = priceOnOrBefore(closes, today);
        status = "open_mark_to_market";
      } else if (!exitPx) {
        exitPx = priceOnOrBefore(closes, targetExit);
      }
      if (!exitPx) {
        results.push({
          ...r,
          status: "no_exit_price",
          entryDate: entry.date,
          entryPrice: round(entry.price),
          targetExitDate: targetExit,
        });
        continue;
      }

      const rawRet = (exitPx.price - entry.price) / entry.price;
      const signedRet = r.direction === "short" ? -rawRet : rawRet;
      const heldDays = Math.max(
        0,
        Math.round(
          (Date.parse(exitPx.date) - Date.parse(entry.date)) / 86400000
        )
      );

      results.push({
        ticker: r.ticker,
        direction: r.direction,
        statusId: r.statusId,
        createdAt: r.createdAt,
        text: r.text,
        url: r.url,
        status,
        holdDays,
        heldDaysActual: heldDays,
        horizonComplete,
        targetExitDate: targetExit,
        entryDate: entry.date,
        entryPrice: round(entry.price),
        exitDate: exitPx.date,
        exitPrice: round(exitPx.price),
        rawMarketReturn: round(rawRet * 100),
        strategyReturn: round(signedRet * 100),
        win: signedRet > 0,
      });
    }
  }

  const scored = results.filter(
    (r) => r.status === "ok" || r.status === "open_mark_to_market"
  );
  const completed = results.filter((r) => r.status === "ok");
  const open = results.filter((r) => r.status === "open_mark_to_market");
  const wins = scored.filter((r) => r.win);
  const avg =
    scored.length > 0
      ? scored.reduce((s, r) => s + r.strategyReturn, 0) / scored.length
      : null;
  const med = scored.length
    ? median(scored.map((r) => r.strategyReturn))
    : null;

  return {
    holdDays,
    tradeCount: scored.length,
    completedCount: completed.length,
    openCount: open.length,
    skipped: results.length - scored.length,
    winRate: scored.length ? round((wins.length / scored.length) * 100) : null,
    avgReturnPct: avg != null ? round(avg) : null,
    medianReturnPct: med != null ? round(med) : null,
    note:
      open.length > 0
        ? "Some trades still inside the style horizon; returns are mark-to-market as of last available close."
        : undefined,
    errors,
    trades: results,
  };
}

function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
