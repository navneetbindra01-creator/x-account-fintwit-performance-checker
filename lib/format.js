/**
 * Display rules for instruments:
 * - Print $CASHTAG only when a cashtag appeared in the tweet text (or parent, if inherited from parent cashtag).
 * - Otherwise name the symbol/stock from text/image without inventing a cashtag.
 */

const NAME_BY_SYMBOL = {
  CL: "crude oil",
  GC: "gold",
  SI: "silver",
  HG: "copper",
  NG: "natural gas",
  ES: "S&P / ES futures",
  NQ: "Nasdaq / NQ futures",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  DOGE: "Dogecoin",
  PEPE: "Pepe",
  TAO: "Bittensor",
  BAND: "Band Protocol",
  XRP: "XRP",
  AVAX: "Avalanche",
  LINK: "Chainlink",
  WIF: "dogwifhat",
  OXY: "Occidental Petroleum",
  CBRL: "Cracker Barrel",
};

/**
 * @param {{ symbol: string, sources?: string[], usedCashtag?: boolean, name?: string, parentStatusId?: string, exchange?: string|null }} info
 */
export function formatInstrument(info) {
  const sym = String(info.symbol || info.ticker || "").toUpperCase();
  const name = info.name || NAME_BY_SYMBOL[sym] || null;
  const sources = info.sources || [];
  const usedCashtag = !!info.usedCashtag || sources.includes("cashtag");
  const exchange = info.exchange
    ? String(info.exchange).replace(/\s+/g, " ").trim()
    : null;
  // e.g. "XBI NYSE" / "XBI (NYSE Arca)" when venue was read off the chart
  const withVenue = exchange ? `${sym} (${exchange})` : sym;

  if (usedCashtag) {
    const core = exchange ? `$${sym} (${exchange})` : `$${sym}`;
    return {
      display: core,
      symbol: sym,
      exchange,
      usedCashtag: true,
      label: name ? `${core} — ${name}` : core,
    };
  }

  // No cashtag in tweet — do not print $TICKER
  const from = describeSources(sources, info);
  if (name) {
    const core = `${name} [${withVenue}]`;
    return {
      display: core,
      symbol: sym,
      exchange,
      usedCashtag: false,
      label: from ? `${core} — ${from}` : core,
    };
  }
  return {
    display: withVenue,
    symbol: sym,
    exchange,
    usedCashtag: false,
    label: from ? `${withVenue} — ${from}` : withVenue,
  };
}

function describeSources(sources, info) {
  const parts = [];
  if (sources.includes("cashtag")) parts.push("cashtag in tweet");
  if (sources.includes("text_name") || sources.includes("intent"))
    parts.push("named in tweet text");
  if (sources.includes("text_symbol")) parts.push("symbol in tweet text");
  if (sources.includes("image") || sources.includes("ocr"))
    parts.push("from chart/image in tweet");
  if (sources.includes("parent_cashtag"))
    parts.push(
      `cashtag in parent tweet${info.parentStatusId ? " " + info.parentStatusId : ""}`
    );
  if (sources.includes("parent_text") || sources.includes("parent_image"))
    parts.push(
      `from parent tweet${info.parentStatusId ? " " + info.parentStatusId : ""}`
    );
  return parts.join("; ");
}

/**
 * Short line for reports.
 * Only include LONG/SHORT when side is obvious; otherwise symbol + tweet only.
 */
export function formatRecHeadline(rec) {
  const inst = formatInstrument(rec);
  const day = (rec.createdAt || "").slice(0, 10);
  const obvious =
    rec.directionObvious === true &&
    (rec.direction === "long" || rec.direction === "short");
  const dir = obvious ? `${rec.direction.toUpperCase()}  ` : "";
  const lvl =
    rec.level != null
      ? ` @ ${rec.level}`
      : rec.levels?.[0]?.level != null
        ? ` @ ${rec.levels[0].level}`
        : "";
  const cond =
    obvious && rec.conditional ? " (conditional / buy zone)" : "";
  return `${day}  ${dir}${inst.label}${lvl}${cond}`.replace(/\s+/g, " ").trim();
}
