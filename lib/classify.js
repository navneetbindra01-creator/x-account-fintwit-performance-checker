import { STYLES, styleFromHoldDays } from "./periods.js";

/**
 * Classify trader style from horizon keyword votes across tweets + optional heuristics.
 */
export function classifyTraderStyle(analyzedTweets, options = {}) {
  const totals = {
    day_trader: 0,
    ultra_short: 0,
    short_term: 0,
    medium_term: 0,
    long_term: 0,
  };

  let tweetsWithVotes = 0;
  for (const t of analyzedTweets) {
    const votes = t.horizonVotes || {};
    const keys = Object.keys(votes);
    if (!keys.length) continue;
    tweetsWithVotes += 1;
    for (const [k, v] of Object.entries(votes)) {
      if (totals[k] != null) totals[k] += v;
    }
  }

  // Heuristic: chartist language without short-term markers → medium/long lean
  const allText = analyzedTweets.map((t) => t.text || "").join("\n");
  if (/\b(weekly|monthly)\s+chart/i.test(allText)) {
    totals.medium_term += 2;
    totals.long_term += 2;
  }
  if (/\b(classical|point\s*&\s*figure|p&f|factor\s*analysis|measured\s*move)\b/i.test(allText)) {
    totals.medium_term += 1;
    totals.long_term += 1;
  }
  if (/\b(scalp|day\s*trade|0dte|intraday)\b/i.test(allText)) {
    totals.day_trader += 3;
  }

  const ranked = Object.entries(totals)
    .map(([id, score]) => ({ id, score, style: STYLES[id] }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const second = ranked[1];
  let confidence = "low";
  if (best.score >= 6 && best.score - (second?.score || 0) >= 3) confidence = "high";
  else if (best.score >= 3) confidence = "medium";
  else if (best.score > 0) confidence = "low";

  // Default when no signals: medium_term (common for public market commentary)
  let chosen = best.score > 0 ? best.style : STYLES.medium_term;
  let method = best.score > 0 ? "keyword_votes" : "default_medium_term";

  // Optional override from measured hold periods (entry/exit pairs) if provided
  if (options.medianHoldDays != null) {
    const fromHold = styleFromHoldDays(options.medianHoldDays);
    if (fromHold) {
      chosen = fromHold;
      method = "median_hold_days";
      confidence = "medium";
    }
  }

  return {
    style: chosen,
    confidence,
    method,
    scores: Object.fromEntries(ranked.map((r) => [r.id, r.score])),
    tweetsWithHorizonSignals: tweetsWithVotes,
    holdDaysForBacktest: chosen.holdDays,
  };
}

export function summarizeSectors(analyzedTweets) {
  const counts = {};
  for (const t of analyzedTweets) {
    for (const s of t.sectors || []) {
      counts[s] = (counts[s] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([sector, count]) => ({ sector, count }))
    .sort((a, b) => b.count - a.count);
}

export function summarizeTickers(recs) {
  const map = {};
  for (const r of recs) {
    const key = r.ticker || r.symbol;
    if (!map[key]) {
      map[key] = {
        ticker: key,
        display: r.display || key,
        label: r.label || key,
        usedCashtag: !!r.usedCashtag,
        mentions: 0,
        long: 0,
        short: 0,
        mention: 0,
        mixed: 0,
        cashtagMentions: 0,
        nonCashtagMentions: 0,
      };
    }
    map[key].mentions += 1;
    if (r.usedCashtag) map[key].cashtagMentions += 1;
    else map[key].nonCashtagMentions += 1;
    // Prefer cashtag display if any rec used it
    if (r.usedCashtag) {
      map[key].usedCashtag = true;
      map[key].display = r.display || `$${key}`;
      map[key].label = r.label || `$${key}`;
    }
    const k =
      r.direction === "long" ||
      r.direction === "short" ||
      r.direction === "mixed"
        ? r.direction
        : "mention";
    map[key][k] = (map[key][k] || 0) + 1;
  }
  return Object.values(map).sort((a, b) => b.mentions - a.mentions);
}
