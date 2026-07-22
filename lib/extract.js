/**
 * Extract instruments with provenance:
 * - cashtag: $AAPL in tweet text → may display as $AAPL
 * - text_name / intent: "crude", "gold", bid language → no invented cashtag
 * - image/ocr: chart labels → no invented cashtag
 * - parent_*: inherited from parent tweet when reply has no symbols
 */

import { formatInstrument } from "./format.js";
import {
  isTradingChartOcr,
  scoreTradingChartOcr,
  extractHighConfidenceChartTickers,
  EXCHANGE_BLOCKLIST,
} from "./chart-detect.js";

const TICKER_BLOCKLIST = new Set([
  "USD","EUR","GBP","JPY","CNY","USDT","USDC",
  "CEO","CTO","IPO","ATH","ATL","IMO","FYI","USA",
  "GDP","CPI","PPI","FED","FOMC","ETF","EPS","PE",
  "AI","IT","TV","AM","PM","DD","TA","FA","ROI","YOY","QOQ",
  "OTC","NYSE","NASDAQ","SEC","FDA","API","PDF","HTTP","HTTPS","WWW",
  "AND","THE","FOR","YOU","ALL","NEW","NOW","OUT","TOP","BIG","LOW","HIGH",
  "BUY","SELL","BID","ASK","OFFER",
]);

const SECTOR_PATTERNS = [
  { sector: "Energy", re: /\b(energy|crude|oil|nat\s*gas|natural gas|wti|brent|xle|xop|oih)\b/i },
  { sector: "Technology", re: /\b(tech|semiconductor|semis?|software|nasdaq|qqq|xlk|mag\s*7|magnificent seven)\b/i },
  { sector: "Financials", re: /\b(bank(s|ing)?|financials?|xlf|regional banks?|insurers?)\b/i },
  { sector: "Healthcare", re: /\b(health\s*care|biotech|pharma|xlv|ibb)\b/i },
  { sector: "Consumer", re: /\b(consumer|retail|discretionary|staples|xl[yp])\b/i },
  { sector: "Industrials", re: /\b(industrials?|transports?|xli|iya)\b/i },
  { sector: "Materials", re: /\b(materials?|mining|metals?|copper|gold|silver|xlb|gdx)\b/i },
  { sector: "Utilities", re: /\b(utilities|utility|xlu)\b/i },
  { sector: "Real Estate", re: /\b(real\s*estate|reits?|xlre)\b/i },
  {
    sector: "Crypto",
    re: /\b(bitcoin|btc|ethereum|eth|crypto|blockchain|solana|dogecoin|pepe|bittensor|defi|altcoin|memecoin)\b/i,
  },
  { sector: "Indexes", re: /\b(s&p|spx|spy|es\b|nq\b|dow|dia|russell|iwm|vix)\b/i },
];

// Note: bare "add" is NOT bullish — "an add for Grand Theft Auto" is advertising slang
const BULLISH_RE =
  /\b(buy|long|longs|bullish|breakout|break\s*out|accumulate|added|adding|overweight|upside|target|going higher|new highs?|support held|buy the dip|bid)\b/i;
const BEARISH_RE =
  /\b(sell|short|shorts|bearish|breakdown|break\s*down|underweight|downside|going lower|new lows?|resistance|fade|trim(ming)?|exit(ed|ing)?|offered?|offer)\b/i;

const HORIZON_PATTERNS = [
  { style: "day_trader", re: /\b(day\s*trad(e|ing|er)?|scalp(ing)?|intraday|same[- ]day)\b/i, weight: 3 },
  { style: "ultra_short", re: /\b(swing\s*trad(e|ing)?|few days|couple of days|next week|this week|weekly)\b/i, weight: 2 },
  { style: "short_term", re: /\b(short[- ]term|one month|1 month|several weeks|next month|monthly)\b/i, weight: 2 },
  { style: "medium_term", re: /\b(medium[- ]term|position\s*trad(e|ing)?|couple of months|2 months|two months|quarter|multi[- ]month)\b/i, weight: 2 },
  { style: "long_term", re: /\b(long[- ]term|invest(ing|ment)?|multi[- ]year|years?|secular|major trend|weekly\/monthly charts?)\b/i, weight: 2 },
  { style: "day_trader", re: /\b(\d{1,2})\s*min(ute)?s?\s*chart\b/i, weight: 2 },
  { style: "ultra_short", re: /\b(hourly|60\s*min|4\s*h(our)?)\s*chart\b/i, weight: 1 },
  { style: "short_term", re: /\b(daily chart|day chart)\b/i, weight: 1 },
  { style: "medium_term", re: /\b(weekly chart)\b/i, weight: 2 },
  { style: "long_term", re: /\b(monthly chart)\b/i, weight: 3 },
];

export const COMMODITY_ALIASES = [
  { re: /\b(crude(?:\s*oil)?|wti|brent)\b/i, ticker: "CL", name: "crude oil" },
  { re: /\b(nat(?:ural)?\s*gas|henry\s*hub)\b/i, ticker: "NG", name: "natural gas" },
  {
    re: /\bgold\b/i,
    ticker: "GC",
    name: "gold",
    exclude: /\b(that was gold|golden|gold!)\b/i,
  },
  { re: /\bsilver\b/i, ticker: "SI", name: "silver" },
  { re: /\bcopper\b/i, ticker: "HG", name: "copper" },
  { re: /\b(bitcoin|btc)\b/i, ticker: "BTC", name: "Bitcoin" },
  { re: /\b(ethereum|ether)\b/i, ticker: "ETH", name: "Ethereum" },
  { re: /\b(s&p|spx|es futures?)\b/i, ticker: "ES", name: "S&P / ES futures" },
  { re: /\b(nasdaq|nq futures?)\b/i, ticker: "NQ", name: "Nasdaq / NQ futures" },
];

const KNOWN_SYMBOLS = new Set([
  "AAPL","MSFT","NVDA","TSLA","AMZN","META","GOOG","GOOGL","NFLX","AMD","INTC",
  "SPY","QQQ","IWM","DIA","TLT","HYG","LQD","GLD","SLV","USO","UNG","XLE","XLF",
  "XLI","XLK","XLV","SMH","ARKK","IYT","DBA","DBB","OXY","XOM","CVX","COP","MPC",
  "VLO","SLB","HAL","BA","CAT","DE","JPM","GS","MS","BAC","WFC","COIN","MSTR",
  "HOOD","PLTR","SOFI","RIVN","NIO","BABA","JD","PDD","UBER","LYFT","DIS","NKE",
  "CBRL","SNDK","WDC","CRWD","PANW","SNOW","CRM","ORCL","IBM","INTU","NOW",
  "BTC","ETH","SOL","ES","NQ","RTY","YM","CL","NG","GC","SI","HG","ZB","ZN","ZF",
  "ZT","SR3","SOFR","UB","VX","VIX","SPX","NDX","RUT","DXY","DX","PBR","LLY",
  "UNH","SNAP","FXI","ABVX","XBI","GOOGL","META",
  // crypto cashtags commonly tweeted alongside equities
  "PEPE","TAO","DOGE","ADA","AVAX","LINK","DOT","ATOM","NEAR","APT","SUI",
  "ARB","OP","INJ","SEI","TIA","WIF","BONK","FET","RENDER","RNDR","AAVE",
  "UNI","MKR","LDO","ENA","HBAR","XRP","LTC","BCH","BNB","TRX","TON","MATIC",
  "POL","SHIB","FLOKI","JUP","PYTH","ONDO","WLD","IMX","STX","FIL","ICP",
  "ALGO","VET","SAND","MANA","AXS","GALA","APE","BLUR","PENDLE","JTO",
  "BAND","RUNE","KAS","ORDI","SATS","NOT","BOME","MEW","POPCAT","MOG",
]);

/** Exported for OCR chart ticker filtering */
export const KNOWN_SYMBOLS_FOR_OCR = KNOWN_SYMBOLS;

/**
 * Symbols that are crypto on Yahoo Finance (…-USD).
 * Prefer explicit map entries for ambiguous tickers (e.g. BAND stock vs BAND-USD).
 */
export const CRYPTO_YAHOO_MAP = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
  DOGE: "DOGE-USD",
  ADA: "ADA-USD",
  AVAX: "AVAX-USD",
  LINK: "LINK-USD",
  DOT: "DOT-USD",
  ATOM: "ATOM-USD",
  NEAR: "NEAR-USD",
  APT: "APT-USD",
  SUI: "SUI-USD",
  ARB: "ARB-USD",
  OP: "OP-USD",
  INJ: "INJ-USD",
  SEI: "SEI-USD",
  TIA: "TIA-USD",
  WIF: "WIF-USD",
  BONK: "BONK-USD",
  FET: "FET-USD",
  RENDER: "RENDER-USD",
  RNDR: "RNDR-USD",
  AAVE: "AAVE-USD",
  UNI: "UNI-USD",
  MKR: "MKR-USD",
  LDO: "LDO-USD",
  ENA: "ENA-USD",
  HBAR: "HBAR-USD",
  XRP: "XRP-USD",
  LTC: "LTC-USD",
  BCH: "BCH-USD",
  BNB: "BNB-USD",
  TRX: "TRX-USD",
  TON: "TON-USD",
  MATIC: "MATIC-USD",
  POL: "POL-USD",
  SHIB: "SHIB-USD",
  FLOKI: "FLOKI-USD",
  JUP: "JUP-USD",
  PYTH: "PYTH-USD",
  ONDO: "ONDO-USD",
  WLD: "WLD-USD",
  IMX: "IMX-USD",
  STX: "STX-USD",
  FIL: "FIL-USD",
  ICP: "ICP-USD",
  ALGO: "ALGO-USD",
  VET: "VET-USD",
  SAND: "SAND-USD",
  MANA: "MANA-USD",
  AXS: "AXS-USD",
  GALA: "GALA-USD",
  APE: "APE-USD",
  BLUR: "BLUR-USD",
  PENDLE: "PENDLE-USD",
  JTO: "JTO-USD",
  // Yahoo sometimes uses numbered ids; plain TICKER-USD usually works for daily charts
  // Yahoo often needs numbered ids for meme / newer coins; plain *-USD tried first
  PEPE: "PEPE-USD",
  TAO: "TAO-USD",
  UNI: "UNI-USD",
  HYPE: "HYPE-USD",
  PUMP: "PUMP-USD",
  // Band Protocol (crypto) — not Bandwidth Inc equity
  BAND: "BAND-USD",
  RUNE: "RUNE-USD",
  KAS: "KAS-USD",
  ORDI: "ORDI-USD",
  BOME: "BOME-USD",
  MEW: "MEW-USD",
  POPCAT: "POPCAT-USD",
  MOG: "MOG-USD",
  NOT: "NOT-USD",
};

export const YAHOO_SYMBOL_MAP = {
  ...CRYPTO_YAHOO_MAP,
  ES: "ES=F",
  NQ: "NQ=F",
  RTY: "RTY=F",
  YM: "YM=F",
  CL: "CL=F",
  NG: "NG=F",
  GC: "GC=F",
  SI: "SI=F",
  HG: "HG=F",
  ZB: "ZB=F",
  ZN: "ZN=F",
  ZF: "ZF=F",
  ZT: "ZT=F",
  VIX: "^VIX",
  SPX: "^GSPC",
  DJIA: "^DJI",
  DXY: "DX-Y.NYB",
  SOFR: "SR3=F",
  SR3: "SR3=F",
};

export function toYahooSymbol(ticker) {
  const t = String(ticker).toUpperCase().replace(/^\$/, "");
  if (YAHOO_SYMBOL_MAP[t]) return YAHOO_SYMBOL_MAP[t];
  // Already a Yahoo-style crypto/futures id
  if (t.includes("-") || t.includes("=") || t.startsWith("^")) return t;
  return t;
}

/** Candidate Yahoo symbols to try (primary + crypto -USD fallback). */
export function yahooSymbolCandidates(ticker) {
  const t = String(ticker).toUpperCase().replace(/^\$/, "");
  const primary = toYahooSymbol(t);
  const out = [primary];
  // If not already mapped to crypto and not futures/index, try -USD
  if (!primary.endsWith("-USD") && !primary.includes("=") && !primary.startsWith("^")) {
    out.push(`${t}-USD`);
  }
  // Yahoo numbered ids when plain TICKER-USD is thin / mis-resolved
  const CRYPTO_ALT_IDS = {
    PEPE: "PEPE24478-USD",
    TAO: "TAO22974-USD",
    UNI: "UNI7083-USD",
    HYPE: "HYPE32196-USD",
    PUMP: "PUMP36507-USD",
  };
  if (CRYPTO_ALT_IDS[t]) out.push(CRYPTO_ALT_IDS[t]);
  return [...new Set(out)];
}

function commodityMatches(text, alias) {
  if (!alias.re.test(text)) return false;
  if (alias.exclude && alias.exclude.test(text)) return false;
  return true;
}

/**
 * True only when the commodity is the *subject* of a trade call,
 * not ambient market color ("price action in crude", "oil was heavy").
 */
function isCommodityTradeSubject(text, alias) {
  if (!commodityMatches(text, alias)) return false;
  const t = text || "";

  // Ambient market color — never treat as a trade on that commodity
  if (
    /\b(price action (?:in|on)|heavy price action|led the|in response|vs\.?|versus|likes? that|because of|on the back of)\b/i.test(
      t
    )
  ) {
    // Still allow explicit "bid in crude" / "long gold" if present
    const explicit = new RegExp(
      `\\b(?:\\$?\\d[\\d,.]*\\s*bid\\s+(?:in|for|on)|(?:got\\s+)?(?:long|short)|buy|buying|bought|sell|sold|dumped)\\b[^.]{0,48}${alias.re.source}`,
      "i"
    );
    if (!explicit.test(t)) return false;
  }

  // Trade verb near commodity name
  const tradeSubject = new RegExp(
    `\\b(?:bid|offer|(?:got\\s+)?long|(?:got\\s+)?short|buy|buying|bought|sell|sold|dumped|watching)\\b[^.]{0,40}${alias.re.source}`,
    "i"
  );
  const subjectTrade = new RegExp(
    `${alias.re.source}[^.]{0,40}\\b(?:bid|offer|long|short|buy|buying|bought|sell|sold)\\b`,
    "i"
  );
  if (tradeSubject.test(t) || subjectTrade.test(t)) return true;

  // "$67 bid in crude" / "I'm $3500 in gold"
  if (
    /\$?\s*[\d,]+(?:\.\d+)?\s*bid\s+(?:in|for|on|at)\s+/i.test(t) &&
    alias.re.test(t)
  ) {
    return true;
  }
  if (
    /(?:i'?m|am|i am)\s+\$?\s*[\d,]+(?:\.\d+)?\s+(?:bid\s+)?(?:in|for|on)\s+/i.test(
      t
    ) &&
    alias.re.test(t)
  ) {
    return true;
  }

  return false;
}

/** Only true $TICKER cashtags from text */
export function extractCashtags(text) {
  if (!text) return [];
  const found = [];
  for (const m of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    const t = m[1].toUpperCase();
    if (!TICKER_BLOCKLIST.has(t)) found.push(t);
  }
  return [...new Set(found)];
}

export function extractTradeIntent(text) {
  if (!text) return { tickers: [], direction: null, levels: [], intents: [] };
  const tickers = new Set();
  const levels = [];
  const intents = [];
  let direction = null;
  const seenIntent = new Set();

  const bidIn = [
    ...text.matchAll(
      /\$?\s*([\d,]+(?:\.\d+)?)\s*bid\s+(?:in|for|on|at)\s+([A-Za-z][A-Za-z\s]{1,20}?)(?:[.,!?]|$)/gi
    ),
    ...text.matchAll(
      /(?:i'?m|am|i am)\s+\$?\s*([\d,]+(?:\.\d+)?)\s*(?:bid\s+)?(?:in|for|on)\s+([A-Za-z][A-Za-z\s]{1,20}?)(?:[.,!?]|$)/gi
    ),
  ];
  for (const m of bidIn) {
    const level = Number(String(m[1]).replace(/,/g, ""));
    const mapped = mapNameToTicker(m[2].trim());
    if (!mapped) continue;
    tickers.add(mapped.ticker);
    const key = `bid:${mapped.ticker}:${level}`;
    if (!seenIntent.has(key)) {
      seenIntent.add(key);
      levels.push({ ticker: mapped.ticker, level, kind: "bid", name: mapped.name });
      intents.push({
        kind: "bid",
        ticker: mapped.ticker,
        name: mapped.name,
        level,
        direction: "long",
        source: "intent",
      });
    }
    direction = "long";
  }

  const levelInAsset = [
    ...text.matchAll(
      /(?:i'?m|am|i am)\s+\$?\s*([\d,]+(?:\.\d+)?)\s+in\s+([A-Za-z][A-Za-z\s]{1,16}?)(?:\s+for|\s+if|[.,!]|$)/gi
    ),
    ...text.matchAll(
      /\$?\s*([\d,]+(?:\.\d+)?)\s+(?:is\s+)?(?:my\s+)?(?:buy\s*zone|bid\s*zone|support|reload|get\s+(?:them|it)\s+back)/gi
    ),
    ...text.matchAll(
      /(?:buy\s*zone|bid\s*zone|support)\s*(?:at|around|near)?\s*\$?\s*([\d,]+(?:\.\d+)?)/gi
    ),
    ...text.matchAll(/working\s+\$?\s*([\d,]+(?:\.\d+)?)\s+to\s+(?:get|buy)/gi),
  ];
  for (const m of levelInAsset) {
    const level = Number(String(m[1]).replace(/,/g, ""));
    if (!Number.isFinite(level)) continue;
    if (m[2]) {
      const mapped = mapNameToTicker(m[2].trim());
      if (!mapped) continue;
      tickers.add(mapped.ticker);
      levels.push({
        ticker: mapped.ticker,
        level,
        kind: "buy_zone",
        name: mapped.name,
      });
      intents.push({
        kind: "buy_zone",
        ticker: mapped.ticker,
        name: mapped.name,
        level,
        direction: "long",
        conditional: true,
        source: "intent",
      });
      direction = direction || "long";
    } else {
      levels.push({ ticker: null, level, kind: "level" });
    }
  }

  for (const alias of COMMODITY_ALIASES) {
    if (!commodityMatches(text, alias)) continue;
    if (intents.some((i) => i.ticker === alias.ticker)) {
      tickers.add(alias.ticker);
      continue;
    }
    // Only when commodity is the trade subject — not "price action in crude"
    if (isCommodityTradeSubject(text, alias)) {
      tickers.add(alias.ticker);
    }
  }

  if (
    /\b(drop (their|your) bags|buy zone|if (?:we|it|price) (?:get|fall|comes?|trades?) (?:to|down))\b/i.test(
      text
    )
  ) {
    for (const alias of COMMODITY_ALIASES) {
      if (!commodityMatches(text, alias)) continue;
      tickers.add(alias.ticker);
      direction = direction || "long";
      if (!intents.some((i) => i.ticker === alias.ticker)) {
        intents.push({
          kind: "conditional_buy",
          ticker: alias.ticker,
          name: alias.name,
          direction: "long",
          conditional: true,
          source: "intent",
        });
      }
    }
  }

  return {
    tickers: [...tickers],
    direction,
    levels,
    intents,
  };
}

function mapNameToTicker(name) {
  const n = name.toLowerCase().replace(/[^a-z\s]/g, " ").trim();
  if (!n) return null;
  const up = n.toUpperCase().replace(/\s+/g, "");
  if (KNOWN_SYMBOLS.has(up) && up.length <= 5) {
    return { ticker: up, name: up };
  }
  for (const a of COMMODITY_ALIASES) {
    if (commodityMatches(n, a)) return { ticker: a.ticker, name: a.name };
  }
  if (KNOWN_SYMBOLS.has(name.toUpperCase())) {
    return { ticker: name.toUpperCase(), name: name.toUpperCase() };
  }
  return null;
}

/**
 * True when the sentence/tweet is clearly about markets / investing.
 * Ordinary chat ("cop car", "loaded with guns") must NOT qualify.
 */
export function hasMarketContext(text) {
  if (!text) return false;
  return /\b(stock|stocks|shares?|equity|equities|ticker|tickers|etf|etfs|options?|calls?|puts?|futures?|commodity|commodities|chart|charts|breakout|breakdown|support|resistance|bid|offer|long|short|portfolio|position|positions|trade|trades|trading|trader|invest(?:ing|ment)?|bullish|bearish|rally|selloff|pullback|dip\b|scalp|swing|hedge|margin|earnings|dividend|nasdaq|nyse|market|markets|spy|qqq|vwap|rsi|macd|\$[A-Za-z]{1,5})\b/i.test(
    text
  );
}

/**
 * Tickers that are also common English words — only allow via cashtag or
 * explicit trade syntax in market context (never free-text word match).
 */
const AMBIGUOUS_WORD_TICKERS = new Set([
  "COP", // cop car
  "CAT", // animal
  "BA", // ?
  "F",
  "T",
  "C",
  "IT",
  "ON",
  "SO",
  "OR",
  "ARE",
  "CAN",
  "HAS",
  "WAS",
  "AN",
  "A",
  "I",
  "GO",
  "DO",
  "ME",
  "HE",
  "WE",
  "US",
  "OUT",
  "TOP",
  "BIG",
  "LOW",
  "HIGH",
  "NEW",
  "OLD",
  "MAN",
  "CAR",
  "LOT",
  "ALL",
  "NOW",
  "ONE",
  "TWO",
  "FOR",
  "THE",
  "AND",
  "YOU",
  "ANY",
  "TOO",
  "VERY",
  "JUST",
  "WELL",
  "BACK",
  "GOOD",
  "BEST",
  "REAL",
  "FAST",
  "SLOW",
  "OPEN",
  "FREE",
  "NEXT",
  "LAST",
  "LIVE",
  "PLAY",
  "RUN",
  "SEE",
  "SET",
  "GET",
  "GOT",
  "PUT", // options "put" is market but word is common — require stronger context
  "CALL",
  "HOLD",
  "BEAT",
  "MISS",
  "EDGE",
  "GAIN",
  "LOSS",
  "RISK",
  "CASH",
  "BOND",
  "GOLD", // handled via commodity alias + market context
  "SILVER",
  "OIL",
  "GAS",
  "DD",
  "AI",
  "CEO",
  "IPO",
  "USA",
  "FBI",
  "CEO",
  "AM",
  "PM",
  "TV",
  "PC",
  "APP",
  "NET",
  "WEB",
  "BOX",
  "FOX",
  "SUN",
  "SEA",
  "AIR",
  "ARM",
  "LEG",
  "EYE",
  "EAR",
  "JOB",
  "LAW",
  "WAR",
  "PEACE",
  "LOVE",
  "LIFE",
  "TIME",
  "YEAR",
  "WEEK",
  "DAY",
  "AGE",
  "KID",
  "MOM",
  "DAD",
  "SON",
  "GUN",
  "GUNS",
  "CAR",
  "CARS",
  "COP",
  "COPS",
  "POLICE",
]);

/**
 * Structured extractions from a single body of text (tweet or parent).
 *
 * Rules:
 * - Only return a ticker when text explicitly refers to a stock/company/market symbol
 * - Do not guess from ordinary words (e.g. "cop car" ≠ COP)
 * - If context is ambiguous, return no match
 */
export function extractSymbolMapFromText(text) {
  const map = new Map(); // symbol -> { sources:Set, name, usedCashtag }

  function add(sym, source, name = null, usedCashtag = false) {
    const s = String(sym).toUpperCase();
    if (!s || TICKER_BLOCKLIST.has(s)) return;
    if (EXCHANGE_BLOCKLIST.has(s)) return;
    if (!map.has(s)) {
      map.set(s, { sources: new Set(), name: name || null, usedCashtag: false });
    }
    const e = map.get(s);
    e.sources.add(source);
    if (usedCashtag) e.usedCashtag = true;
    if (name && !e.name) e.name = name;
  }

  if (!text) return map;

  // 1) Explicit cashtags — always allowed ($AAPL, $COP)
  for (const t of extractCashtags(text)) add(t, "cashtag", null, true);

  // 2) Bid / buy-zone / commodity intents (already market-phrased)
  const intent = extractTradeIntent(text);
  for (const i of intent.intents) {
    add(i.ticker, "intent", i.name || null, false);
  }
  for (const t of intent.tickers) {
    const alias = COMMODITY_ALIASES.find((a) => a.ticker === t);
    add(t, "text_name", alias?.name || null, false);
  }

  const market = hasMarketContext(text);

  // 3) Explicit trade syntax: "long AAPL", "sold TSLA", "buy $NVDA"
  //    Requires market context OR a cashtag form for ambiguous words.
  const bare = text.matchAll(
    /\b(?:long|short|buy|sell|sold|dumped|watching|bought|buying|trim(?:med|ming)?|cover(?:ed|ing)?)\s+\$?([A-Za-z]{1,5})\b/gi
  );
  for (const m of bare) {
    const t = m[1].toUpperCase();
    if (!KNOWN_SYMBOLS.has(t)) continue;
    if (AMBIGUOUS_WORD_TICKERS.has(t) && !market) continue;
    // Reject lowercase common-word hits: only accept if written as ticker-ish
    // (all-caps in source) or market context is strong
    const raw = m[1];
    const looksLikeTicker = raw === raw.toUpperCase() && raw.length >= 1;
    if (AMBIGUOUS_WORD_TICKERS.has(t) && !looksLikeTicker && !/\$/.test(m[0])) {
      continue;
    }
    if (!market && !looksLikeTicker) continue;
    add(t, "text_symbol", null, false);
  }

  // 4) ALL-CAPS known symbols in market context only (never case-insensitive word scan)
  //    e.g. "sold COP into the close" — not "cop car"
  if (market) {
    for (const m of text.matchAll(/\b([A-Z]{1,5})\b/g)) {
      const t = m[1];
      if (!KNOWN_SYMBOLS.has(t)) continue;
      if (AMBIGUOUS_WORD_TICKERS.has(t) && t.length <= 3) {
        // short ambiguous ALL-CAPS still need nearby trade verb
        const idx = m.index ?? 0;
        const window = text.slice(Math.max(0, idx - 40), idx + t.length + 40);
        if (
          !/\b(long|short|buy|sell|sold|bought|calls?|puts?|shares?|stock|ticker|etf|position)\b/i.test(
            window
          )
        ) {
          continue;
        }
      }
      add(t, "text_symbol", null, false);
    }
  }

  // 5) Commodity only when it is clearly the trade subject (not ambient color)
  for (const alias of COMMODITY_ALIASES) {
    if (isCommodityTradeSubject(text, alias)) {
      add(alias.ticker, "text_name", alias.name, false);
    }
  }

  return map;
}

export function extractTickersFromOcr(ocrText) {
  // Strict path: only high-confidence chart symbols (never exchanges as tickers)
  return extractHighConfidenceChartTickers(ocrText, KNOWN_SYMBOLS).map(
    (h) => h.symbol
  );
}

export function extractSectors(text) {
  if (!text) return [];
  const out = [];
  for (const { sector, re } of SECTOR_PATTERNS) {
    if (re.test(text)) out.push(sector);
  }
  return out;
}

/**
 * Regex Long/Short is disabled.
 * Direction defaults to neutral; optional LLM overlay sets Long/Short/Neutral.
 * @returns {{ direction: 'long'|'short'|'mixed'|'neutral', obvious: boolean, reason?: string }}
 */
export function extractDirectionDetailed(_text) {
  return { direction: "neutral", obvious: false, reason: "llm_or_neutral_only" };
}

export function extractDirection(_text) {
  return "neutral";
}

export function extractHorizonVotes(text) {
  const votes = {};
  if (!text) return votes;
  for (const { style, re, weight } of HORIZON_PATTERNS) {
    if (re.test(text)) votes[style] = (votes[style] || 0) + weight;
  }
  return votes;
}

/**
 * Merge symbol maps; later sources add provenance.
 */
function mergeSymbolMaps(...maps) {
  const out = new Map();
  for (const map of maps) {
    if (!map) continue;
    for (const [sym, info] of map) {
      if (EXCHANGE_BLOCKLIST.has(String(sym).toUpperCase())) continue;
      if (!out.has(sym)) {
        out.set(sym, {
          sources: new Set(info.sources || []),
          name: info.name || null,
          usedCashtag: !!info.usedCashtag,
          parentStatusId: info.parentStatusId || null,
          exchange: info.exchange || null,
        });
      } else {
        const e = out.get(sym);
        for (const s of info.sources || []) e.sources.add(s);
        if (info.usedCashtag) e.usedCashtag = true;
        if (info.name && !e.name) e.name = info.name;
        if (info.parentStatusId) e.parentStatusId = info.parentStatusId;
        if (info.exchange && !e.exchange) e.exchange = info.exchange;
      }
    }
  }
  return out;
}

function symbolMapFromOcr(ocrText, sourceTag = "image") {
  const map = new Map();
  // Refuse non-chart images entirely (beach photos, memes, etc.)
  if (!isTradingChartOcr(ocrText)) return map;

  const hits = extractHighConfidenceChartTickers(ocrText, KNOWN_SYMBOLS);
  for (const hit of hits) {
    const t = typeof hit === "string" ? hit : hit.symbol;
    if (!t || EXCHANGE_BLOCKLIST.has(t)) continue;
    const exchange = typeof hit === "object" ? hit.exchange || null : null;
    const alias = COMMODITY_ALIASES.find((a) => a.ticker === t);
    map.set(t, {
      sources: new Set([sourceTag]),
      name: alias?.name || null,
      usedCashtag: false,
      exchange,
    });
  }
  return map;
}

function mapToList(map) {
  return [...map.entries()].map(([symbol, info]) => {
    const sources = [...info.sources];
    const base = {
      symbol,
      ticker: symbol, // backtest compat
      sources,
      usedCashtag: !!info.usedCashtag,
      name: info.name || null,
      parentStatusId: info.parentStatusId || null,
      exchange: info.exchange || null,
    };
    const fmt = formatInstrument(base);
    return {
      ...base,
      display: fmt.display,
      label: fmt.label,
      exchange: fmt.exchange || base.exchange,
    };
  });
}

/**
 * Analyze one tweet. Uses parent text/image if reply and no local symbols.
 */
export function analyzeTweet(tweet) {
  const text = tweet.text || "";
  const intent = extractTradeIntent(text);
  let localMap = extractSymbolMapFromText(text);
  const textOnlySize = localMap.size;
  const intentSyms = new Set(intent.tickers);

  // Own image OCR — only real trading charts (not beach photos / memes)
  const ocrText = tweet.imageOcr || tweet.ocrText || "";
  const chartMeta = scoreTradingChartOcr(ocrText);
  let ocrMap = new Map();
  const allowImage =
    tweet.imageIsChart !== false && ocrText && chartMeta.isChart;

  if (allowImage) {
    ocrMap = symbolMapFromOcr(ocrText, "image");
    // One primary chart symbol per tweet
    if (ocrMap.size > 1) {
      ocrMap = new Map([[...ocrMap.entries()][0]]);
    }
  }

  // Chart is the subject of the post when OCR is high-confidence equity/chart.
  // Drop ambient commodity text (e.g. "price action in crude") so we don't
  // double-list the same tweet as both CL and CBRL.
  if (ocrMap.size > 0) {
    const chartPrimary = [...ocrMap.keys()][0];
    const intentOnly = new Set(
      (intent.intents || []).map((i) => i.ticker).filter(Boolean)
    );
    for (const [sym, info] of [...localMap.entries()]) {
      if (sym === chartPrimary) continue;
      // Keep only if cashtag or explicit commodity trade intent on that symbol
      const sources = info.sources || new Set();
      const isCashtag = info.usedCashtag || sources.has?.("cashtag");
      const isIntent = intentOnly.has(sym) || sources.has?.("intent");
      if (!isCashtag && !isIntent) {
        // Ambient text_name / weak text_symbol about another market → drop
        localMap.delete(sym);
      }
    }
    // Chart primary wins as the single instrument when text only had ambient commodities
    localMap = mergeSymbolMaps(localMap, ocrMap);
  } else {
    localMap = mergeSymbolMaps(localMap, ocrMap);
  }

  // Parent fallback: no symbols from text/image, but is a reply
  let usedParent = false;
  if (
    localMap.size === 0 &&
    (tweet.isReply || tweet.parentStatusId || tweet.parentText || tweet.parentImageOcr)
  ) {
    usedParent = true;
    let parentMap = extractSymbolMapFromText(tweet.parentText || "");
    // re-tag sources as parent
    const retagged = new Map();
    for (const [sym, info] of parentMap) {
      const sources = new Set();
      for (const s of info.sources) {
        if (s === "cashtag") sources.add("parent_cashtag");
        else if (s === "image" || s === "ocr") sources.add("parent_image");
        else sources.add("parent_text");
      }
      retagged.set(sym, {
        sources,
        name: info.name,
        // Only show $ if parent actually had cashtag
        usedCashtag: info.usedCashtag && sources.has("parent_cashtag"),
        parentStatusId: tweet.parentStatusId || null,
      });
    }
    parentMap = retagged;

    const parentOcr = symbolMapFromOcr(
      tweet.parentImageOcr || "",
      "parent_image"
    );
    for (const [sym, info] of parentOcr) {
      info.parentStatusId = tweet.parentStatusId || null;
      info.usedCashtag = false;
    }
    localMap = mergeSymbolMaps(parentMap, parentOcr);
  }

  const instruments = mapToList(localMap);
  const tickers = instruments.map((i) => i.symbol);

  // Side is not inferred by regex — LLM optional pass sets Long/Short/Neutral
  const direction = "neutral";
  const directionObvious = false;
  const directionReason = "pending_or_llm_off";

  return {
    ...tweet,
    tickers,
    instruments,
    usedParent,
    sectors: extractSectors(text + " " + (tweet.parentText || "")),
    direction,
    directionObvious,
    directionReason,
    horizonVotes: extractHorizonVotes(text),
    levels: intent.levels,
    intents: intent.intents,
    sources: {
      cashtags: extractCashtags(text),
      instruments,
      usedParent,
    },
  };
}

/**
 * Build recommendations with display rules (no fake cashtags).
 */
export function buildRecommendations(analyzedTweets) {
  const recs = [];
  for (const t of analyzedTweets) {
    const instruments =
      t.instruments ||
      (t.tickers || []).map((ticker) => ({
        symbol: ticker,
        ticker,
        sources: ["unknown"],
        usedCashtag: false,
        display: ticker,
        label: ticker,
      }));

    if (!instruments.length) continue;

    // Default: no Long/Short (mention). LLM pass may set side later.
    const obvious = t.directionObvious === true;
    let dir = "mention";
    if (obvious && (t.direction === "long" || t.direction === "short")) {
      dir = t.direction;
    }

    for (const inst of instruments) {
      const intent = (t.intents || []).find((i) => i.ticker === inst.symbol);
      const direction = dir;

      const conf =
        direction === "mention"
          ? "low"
          : t.directionReason === "llm"
            ? "high"
            : "medium";

      const fmt = formatInstrument(inst);
      recs.push({
        ticker: inst.symbol,
        symbol: inst.symbol,
        display: fmt.display,
        label: fmt.label,
        usedCashtag: fmt.usedCashtag,
        exchange: inst.exchange || fmt.exchange || null,
        name: inst.name || null,
        sources: inst.sources || [],
        direction,
        directionObvious: obvious && (direction === "long" || direction === "short"),
        directionReason: t.directionReason || "llm_off",
        llmSide: t.llmSide ?? null,
        confidence: conf,
        conditional: intent?.conditional || false,
        level: intent?.level ?? null,
        intentKind: intent?.kind || null,
        statusId: t.statusId,
        createdAt: t.createdAt,
        text: t.text,
        url: t.url,
        sectors: t.sectors,
        levels: (t.levels || []).filter(
          (l) => !l.ticker || l.ticker === inst.symbol
        ),
        imageOcr: t.imageOcr || null,
        isReply: !!t.isReply,
        parentStatusId: t.parentStatusId || inst.parentStatusId || null,
        parentText: t.parentText || null,
        parentUrl: t.parentStatusId
          ? `https://x.com/i/status/${t.parentStatusId}`
          : null,
        usedParent: !!t.usedParent,
      });
    }
  }
  return recs;
}

// Back-compat helpers used by older code paths
export function extractTickers(text) {
  return [...extractSymbolMapFromText(text).keys()];
}
