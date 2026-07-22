import { analyzeTweet, buildRecommendations } from "./lib/extract.js";

const samples = [
  {
    statusId: "1",
    text: "I'm $67 bid in crude, the scene of the original crime",
    createdAt: "2026-06-24",
  },
  {
    statusId: "2",
    text: "I'm $3500 in gold for any of you twats that want to drop their bags off when we get there.",
    createdAt: "2026-07-20",
  },
  {
    statusId: "3",
    text: "Loaded $CBRL here",
    createdAt: "2025-06-01",
  },
];

for (const s of samples) {
  const a = analyzeTweet(s);
  console.log(
    JSON.stringify(
      {
        text: s.text.slice(0, 70),
        tickers: a.tickers,
        dir: a.direction,
        levels: a.levels,
        intents: a.intents,
      },
      null,
      2
    )
  );
}
console.log(
  "recs",
  buildRecommendations(samples.map(analyzeTweet)).map((r) => ({
    t: r.ticker,
    d: r.direction,
    level: r.level,
    cond: r.conditional,
  }))
);
