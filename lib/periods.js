/** Time-period presets and monthly batch windows. */

export const PERIODS = {
  "10d": { label: "past 10 days", days: 10, months: 1, single: true },
  "30d": { label: "past 30 days", days: 30, months: 1, single: true },
  "1m": { label: "past 1 month", days: 30, months: 1, single: true },
  "2m": { label: "past 2 months", days: 60, months: 2 },
  "3m": { label: "past 3 months", days: 92, months: 3 },
  "6m": { label: "past 6 months", days: 183, months: 6 },
  "1y": { label: "past year", days: 365, months: 12 },
  "3y": { label: "past 3 years", days: 365 * 3, months: 36 },
};

export function resolvePeriod(input) {
  if (!input) return { key: "1m", ...PERIODS["1m"] };
  const key = String(input).toLowerCase().trim();
  if (PERIODS[key]) return { key, ...PERIODS[key] };
  const n = Number(key);
  if (Number.isFinite(n) && n > 0) {
    const months = Math.max(1, Math.ceil(n / 30));
    return {
      key: `${n}d`,
      label: `past ${n} days`,
      days: n,
      months,
      single: n <= 30,
    };
  }
  throw new Error(
    `Unknown period "${input}". Use: ${Object.keys(PERIODS).join(", ")}`
  );
}

export function sinceDate(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Split a multi-month period into 1-month (30-day) batches going back from asOf.
 * Batch 1 = most recent month; last batch = oldest.
 *
 * For periods ≤ 1 month / 30 days / 10 days → single batch.
 *
 * @returns {Array<{ index, total, since, until, untilInclusive, label, key }>}
 *   since/untilInclusive inclusive; until is exclusive (for X search until:)
 */
export function buildMonthBatches(period, asOf = new Date()) {
  const end = new Date(
    Date.UTC(
      asOf.getUTCFullYear(),
      asOf.getUTCMonth(),
      asOf.getUTCDate()
    )
  );

  let nMonths = period.months ?? 1;
  if (period.single || period.days <= 30) {
    nMonths = 1;
  }

  // Single short window (10d / 30d / 1m)
  if (nMonths === 1) {
    const days = period.days || 30;
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days);
    const untilEx = new Date(end);
    untilEx.setUTCDate(untilEx.getUTCDate() + 1);
    return [
      {
        index: 1,
        total: 1,
        since: ymd(start),
        until: ymd(untilEx),
        untilInclusive: ymd(end),
        label: `${ymd(start)} to ${ymd(end)}`,
        key: `${ymd(start)}_to_${ymd(end)}`,
        days,
      },
    ];
  }

  // Rolling 30-day windows from today going back
  const batches = [];
  for (let i = 0; i < nMonths; i++) {
    const windowEnd = new Date(end);
    windowEnd.setUTCDate(windowEnd.getUTCDate() - i * 30);
    const windowStart = new Date(end);
    windowStart.setUTCDate(windowStart.getUTCDate() - (i + 1) * 30);
    const untilEx = new Date(windowEnd);
    untilEx.setUTCDate(untilEx.getUTCDate() + 1);

    batches.push({
      index: i + 1,
      total: nMonths,
      since: ymd(windowStart),
      until: ymd(untilEx),
      untilInclusive: ymd(windowEnd),
      label: `${ymd(windowStart)} to ${ymd(windowEnd)}`,
      key: `${ymd(windowStart)}_to_${ymd(windowEnd)}`,
      days: 30,
    });
  }
  return batches;
}

/** Trader-style horizons (legacy; charts no longer depend on these for P&L). */
export const STYLES = {
  day_trader: {
    id: "day_trader",
    label: "Day trader",
    description: "< 1 day holding period",
    holdDays: 1,
    rank: 1,
  },
  ultra_short: {
    id: "ultra_short",
    label: "Ultra short term",
    description: "< 10 days",
    holdDays: 10,
    rank: 2,
  },
  short_term: {
    id: "short_term",
    label: "Short term",
    description: "1 month+",
    holdDays: 30,
    rank: 3,
  },
  medium_term: {
    id: "medium_term",
    label: "Medium term",
    description: "2 months+",
    holdDays: 60,
    rank: 4,
  },
  long_term: {
    id: "long_term",
    label: "Long term",
    description: "6 months+",
    holdDays: 180,
    rank: 5,
  },
};

export function styleFromHoldDays(medianDays) {
  if (medianDays == null || Number.isNaN(medianDays)) return null;
  if (medianDays < 1.5) return STYLES.day_trader;
  if (medianDays < 10) return STYLES.ultra_short;
  if (medianDays < 45) return STYLES.short_term;
  if (medianDays < 150) return STYLES.medium_term;
  return STYLES.long_term;
}
