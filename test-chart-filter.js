import {
  isTradingChartOcr,
  scoreTradingChartOcr,
  extractHighConfidenceChartTickers,
} from "./lib/chart-detect.js";
import { analyzeTweet, buildRecommendations, KNOWN_SYMBOLS_FOR_OCR } from "./lib/extract.js";
import { readFileSync } from "fs";

// JAX Beach photo OCR (garbage)
const j = JSON.parse(
  readFileSync(
    "output/Jimmyjude13_1y_2026-07-21T13-25-58-712Z.json",
    "utf8"
  )
);
const beach = j.tweets.items.find((t) => t.statusId === "2063695198706643173");
const cbrl = j.tweets.items.find((t) => t.statusId === "2064438930192084995");

console.log("=== Beach photo ===");
console.log("text:", beach.text);
console.log("isChart:", isTradingChartOcr(beach.imageOcr));
console.log("score:", scoreTradingChartOcr(beach.imageOcr).score);
console.log(
  "hi tickers:",
  extractHighConfidenceChartTickers(beach.imageOcr, KNOWN_SYMBOLS_FOR_OCR)
);
const a1 = analyzeTweet(beach);
console.log("instruments:", a1.instruments);
console.log("direction:", a1.direction);
console.log("recs:", buildRecommendations([a1]).length);

console.log("\n=== CBRL chart ===");
console.log("text:", cbrl.text.slice(0, 80));
console.log("isChart:", isTradingChartOcr(cbrl.imageOcr));
console.log("score:", scoreTradingChartOcr(cbrl.imageOcr).score);
console.log(
  "hi tickers:",
  extractHighConfidenceChartTickers(cbrl.imageOcr, KNOWN_SYMBOLS_FOR_OCR)
);
const a2 = analyzeTweet(cbrl);
console.log(
  "instruments:",
  a2.instruments.map((i) => i.label)
);
console.log("direction:", a2.direction);
