import { analyzeTweet, buildRecommendations } from "./lib/extract.js";
import { formatRecHeadline } from "./lib/format.js";

const samples = [
  {
    statusId: "1",
    text: "I'm $67 bid in crude, the scene of the original crime",
    createdAt: "2026-06-24T00:00:00Z",
    url: "https://x.com/x/status/1",
  },
  {
    statusId: "2",
    text: "I'm $3500 in gold for any of you twats that want to drop their bags off when we get there.",
    createdAt: "2026-07-20T00:00:00Z",
    url: "https://x.com/x/status/2",
  },
  {
    statusId: "3",
    text: "Loaded $CBRL here",
    createdAt: "2025-06-01T00:00:00Z",
    url: "https://x.com/x/status/3",
  },
  {
    statusId: "4",
    text: "Buying all my scalps back here, going back to full boat",
    createdAt: "2026-01-23T00:00:00Z",
    imageOcr: "CBRL NASDAQ daily chart",
    chartTickers: ["CBRL"],
    url: "https://x.com/x/status/4",
  },
  {
    statusId: "5",
    text: "Nailed it",
    isReply: true,
    parentStatusId: "99",
    parentText: "Long $OXY into support",
    createdAt: "2026-05-01T00:00:00Z",
    url: "https://x.com/x/status/5",
  },
];

for (const s of samples) {
  const a = analyzeTweet(s);
  console.log(
    s.statusId,
    a.instruments.map((i) => ({
      label: i.label,
      cashtag: i.usedCashtag,
      sources: i.sources,
    }))
  );
}
console.log("\nHeadlines:");
for (const r of buildRecommendations(samples.map(analyzeTweet))) {
  console.log(formatRecHeadline(r));
  console.log("  usedCashtag=", r.usedCashtag, "sources=", r.sources);
}
