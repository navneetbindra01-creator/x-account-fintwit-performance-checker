/**
 * Yahoo Finance daily history (no API key).
 * Stocks/ETFs use bare tickers; crypto uses SYMBOL-USD (with fallbacks).
 */
import { toYahooSymbol, yahooSymbolCandidates } from "./extract.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toUnix(d) {
  return Math.floor(new Date(d).getTime() / 1000);
}

function dayKey(tsSec) {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

async function fetchYahooChart(yahoo, period1, period2) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}` +
    `?interval=1d&period1=${period1}&period2=${period2}&events=history`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Yahoo ${yahoo}: HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const desc = json?.chart?.error?.description;
    throw new Error(`Yahoo ${yahoo}: ${desc || "no data"}`);
  }
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || Number.isNaN(c)) continue;
    points.push({ date: dayKey(ts[i]), close: c, t: ts[i] * 1000 });
  }
  if (points.length < 2) throw new Error(`Yahoo ${yahoo}: insufficient history`);
  return { yahoo, points };
}

export async function fetchDailySeries(symbol, startDate, endDate) {
  const period1 = toUnix(startDate) - 3 * 86400;
  const period2 = toUnix(endDate) + 3 * 86400;
  const candidates = yahooSymbolCandidates(symbol);
  const errors = [];
  for (const yahoo of candidates) {
    try {
      return await fetchYahooChart(yahoo, period1, period2);
    } catch (e) {
      errors.push(`${yahoo}: ${e.message}`);
    }
  }
  throw new Error(
    `Yahoo ${String(symbol).toUpperCase()}: tried ${candidates.join(", ")} — ${errors.join("; ")}`
  );
}

/**
 * Build 12-month series ending today (or asOf).
 */
export async function fetch12MonthSeries(symbol, asOf = new Date()) {
  const end = new Date(asOf);
  const start = new Date(asOf);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  return fetchDailySeries(
    symbol,
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10)
  );
}

export { sleep, toYahooSymbol };
