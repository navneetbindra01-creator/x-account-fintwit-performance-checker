/**
 * Heuristics: is OCR text from a trading chart vs a regular photo?
 * Photos of beaches/people produce random letter noise that matches tickers (BA, DE, ES…).
 */

/** Never treat these as equity/futures tickers — they are venues / platforms */
export const EXCHANGE_BLOCKLIST = new Set([
  "NYSE",
  "NASDAQ",
  "ARCA",
  "NYMEX",
  "COMEX",
  "CME",
  "CBOT",
  "CBOE",
  "OTC",
  "AMEX",
  "BATS",
  "IEX",
  "LSE",
  "TSX",
  "HKEX",
  "SSE",
  "FOREX",
  "CRYPTO",
  "INDEX",
  "ETF", // venue-ish label on some UIs
  "SMA", // indicators often OCR'd as tickers
  "EMA",
  "RSI",
  "MACD",
  "VWAP",
  "ATR",
  "VOLUME",
  "OPEN",
  "HIGH",
  "LOW",
  "CLOSE",
  "LAST",
]);

const EXCHANGE_DETECT_RE =
  /\b(NASDAQ|NYSE(?:\s+Arca)?|ARCA|NYMEX|COMEX|CME|CBOT|CBOE|OTC|AMEX)\b/gi;

const CHART_POSITIVE = [
  /\b(NASDAQ|NYSE|ARCA|NYMEX|COMEX|CME|CBOT|CBOE|OTC|AMEX)\b/i,
  /\b(TradingView|thinkorswim|Thinkorswim|TrendSpider|Bloomberg|StockCharts)\b/i,
  /\b(Inc\.|Corp\.|Ltd\.|PLC|ETF|Futures?)\b/i,
  /\$[A-Za-z]{1,5}\b/,
  /\b[A-Z]{1,5}\s*[-–—]\s*[A-Z0-9][A-Za-z0-9 .,&]{1,40}\b/,
  /\b[A-Z]{1,5}\s*1\s*!/,
  /\b(?:O|H|L|C)\s*[\d,.]+/,
  /[+\-−]\s*\d+\.\d+\s*%/,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b.*\b20\d{2}\b/i,
  /\b(Volume|Vol\.|RSI|MACD|EMA|SMA|VWAP|ATR|Fibonacci|1\.618|0\.618)\b/i,
  /\b\d{2,5}\.\d{2}\b.*\b\d{2,5}\.\d{2}\b/,
];

const CHART_NEGATIVE = [
  /\b(beach|ocean|sunset|wedding|birthday|selfie|dog|cat|puppy|restaurant|menu|lobster|parking)\b/i,
  /\b(Grand Theft Auto|GTA|Xbox|PlayStation|Instagram|Snapchat)\b/i,
  /\b(Basement|basement)\b/,
];

/**
 * @returns {{ isChart: boolean, score: number, reasons: string[] }}
 */
export function scoreTradingChartOcr(ocrText) {
  const text = (ocrText || "").replace(/\s+/g, " ").trim();
  const reasons = [];
  if (text.length < 20) {
    return { isChart: false, score: -10, reasons: ["ocr_too_short"] };
  }

  let score = 0;
  for (const re of CHART_POSITIVE) {
    if (re.test(text)) {
      score += 2;
      reasons.push(`+ ${re.source.slice(0, 40)}`);
    }
  }
  for (const re of CHART_NEGATIVE) {
    if (re.test(text)) {
      score -= 4;
      reasons.push(`- ${re.source.slice(0, 40)}`);
    }
  }

  const tokens = text.split(/[^A-Za-z0-9.%+\-]+/).filter(Boolean);
  if (tokens.length > 30) {
    const shortJunk = tokens.filter((t) => t.length <= 2).length;
    const junkRatio = shortJunk / tokens.length;
    if (junkRatio > 0.45) {
      score -= 5;
      reasons.push(`- high_junk_ratio=${junkRatio.toFixed(2)}`);
    }
  }

  const caps3 = (text.match(/\b[A-Z]{3}\b/g) || []).length;
  if (caps3 > 25 && score < 4) {
    score -= 3;
    reasons.push("- caps_soup");
  }

  return { isChart: score >= 3, score, reasons };
}

export function isTradingChartOcr(ocrText) {
  return scoreTradingChartOcr(ocrText).isChart;
}

function isBlockedSymbol(s) {
  return EXCHANGE_BLOCKLIST.has(String(s).toUpperCase());
}

/**
 * Detect exchange label near a symbol in OCR (for display: "XBI (NYSE)").
 */
export function detectExchangeNearSymbol(ocrText, symbol) {
  const text = (ocrText || "").replace(/\s+/g, " ");
  const sym = String(symbol).toUpperCase();
  // "XBI - 1D - NYSE Arca" or "XBI NYSE" or "XBI ... NASDAQ"
  const re = new RegExp(
    `\\b${sym}\\b.{0,40}?\\b(NASDAQ|NYSE(?:\\s+Arca)?|ARCA|NYMEX|COMEX|CME|CBOT|CBOE|AMEX)\\b`,
    "i"
  );
  const m = text.match(re);
  if (m) {
    // Normalize "NYSE Arca" → keep full venue when present
    const full = text.match(
      new RegExp(
        `\\b${sym}\\b.{0,40}?\\b(NYSE\\s+Arca|NASDAQ|NYSE|ARCA|NYMEX|COMEX|CME|CBOT|CBOE|AMEX)\\b`,
        "i"
      )
    );
    return (full?.[1] || m[1]).replace(/\s+/g, " ").trim();
  }
  // Fallback: any exchange mentioned on the chart title line
  const head = text.slice(0, 160);
  if (new RegExp(`\\b${sym}\\b`, "i").test(head)) {
    const ex = head.match(
      /\b(NYSE\s+Arca|NASDAQ|NYSE|ARCA|NYMEX|COMEX|CME|CBOT|CBOE|AMEX)\b/i
    );
    if (ex) return ex[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

/**
 * High-confidence tickers from a verified chart OCR string only.
 * Returns { symbol, exchange?, score }[] — exchange is venue, never the ticker.
 * Prefers "XBI - 1D - NYSE Arca" style titles over bare exchange names.
 */
export function extractHighConfidenceChartTickers(ocrText, knownSymbols) {
  if (!isTradingChartOcr(ocrText)) return [];

  const text = (ocrText || "").replace(/\s+/g, " ");
  const found = new Map(); // symbol -> score

  function bump(sym, pts) {
    const s = String(sym).toUpperCase();
    if (!s || s.length > 5) return;
    if (isBlockedSymbol(s)) return; // never NYSE/NASDAQ/SMA/…
    if (knownSymbols && !knownSymbols.has(s) && s.length < 4) return;
    // Prefer known symbols; allow 3–5 letter unknowns only with high points later
    found.set(s, (found.get(s) || 0) + pts);
  }

  // Cashtag on chart
  for (const m of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) bump(m[1], 10);

  // "XBI - 1D - NYSE" / "XBI - Cracker Barrel" / "CBRL - Company"
  for (const m of text.matchAll(
    /\b([A-Z]{1,5})\s*[-–—]\s*(?:1D|1W|1M|4H|D|W|M|[\d.]+|[A-Z][A-Za-z0-9 .,&'()]{2,50})/g
  )) {
    bump(m[1], 14);
  }

  // SYMBOL ... exchange (capture symbol BEFORE venue, never the venue itself)
  for (const m of text.matchAll(
    /\b([A-Z]{1,5})\b(?:\s*[-–—]\s*(?:1D|1W|1M|4H|D|W|M))?[^A-Za-z0-9]{0,24}(?:NASDAQ|NYSE(?:\s+Arca)?|ARCA|NYMEX|COMEX|CME|CBOT|CBOE|AMEX)\b/gi
  )) {
    const sym = m[1].toUpperCase();
    if (!isBlockedSymbol(sym)) bump(sym, 13);
  }

  // Futures CL1! GC1!
  for (const m of text.matchAll(
    /\b(CL|GC|SI|HG|NG|ES|NQ|RTY|YM|ZB|ZN|ZF|ZT)\s*1?\s*!/gi
  )) {
    bump(m[1], 10);
  }

  // Title head: first solid ticker-like token before timeframe/exchange
  // e.g. "o XBI - 1D - NYSE Arca"
  const title = text.slice(0, 100);
  const titleHit = title.match(
    /\b([A-Z]{2,5})\s*[-–—]\s*(?:1D|1W|1M|4H|D|W|M)\b/
  );
  if (titleHit && !isBlockedSymbol(titleHit[1])) {
    bump(titleHit[1], 15);
  }

  let ranked = [...found.entries()]
    .filter(([s]) => !isBlockedSymbol(s))
    .filter(([s]) => !knownSymbols || knownSymbols.has(s) || s.length >= 3)
    .sort((a, b) => b[1] - a[1])
    .filter(([, pts]) => pts >= 8);

  // Prefer knownSymbols when scores are close
  if (knownSymbols && ranked.length > 1) {
    ranked.sort((a, b) => {
      const ak = knownSymbols.has(a[0]) ? 1 : 0;
      const bk = knownSymbols.has(b[0]) ? 1 : 0;
      if (bk !== ak) return bk - ak;
      return b[1] - a[1];
    });
  }

  const top = ranked.slice(0, 2);
  return top.map(([symbol, score]) => {
    const exchange = detectExchangeNearSymbol(text, symbol);
    return { symbol, exchange, score };
  });
}

/**
 * Back-compat: return string[] of symbols only.
 */
export function extractHighConfidenceChartTickerSymbols(ocrText, knownSymbols) {
  return extractHighConfidenceChartTickers(ocrText, knownSymbols).map(
    (x) => x.symbol
  );
}
