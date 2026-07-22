/**
 * Re-run extract + optional LLM sides + price charts on a saved scrape JSON.
 *
 * Usage:
 *   node reanalyze-json.js output/RockBtmEntries_....json
 *   node reanalyze-json.js output/latest.json --llm
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { analyzeTweet, buildRecommendations } from "./lib/extract.js";
import {
  classifyTraderStyle,
  summarizeSectors,
  summarizeTickers,
} from "./lib/classify.js";
import { buildPriceChartsForReport } from "./lib/price-chart.js";
import {
  collectTweetsForLlm,
  classifyDirectionsWithLlm,
  applyDirectionLabels,
  applyDirectionToAnalyzed,
  formatLlmTable,
} from "./lib/llm-direction.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const path =
  args.find((a) => !a.startsWith("-")) ||
  join(__dirname, "output", "latest.json");
let llm =
  process.env.USE_LLM === "1" || process.env.USE_LLM === "true";
if (args.includes("--llm")) llm = true;
if (args.includes("--no-llm")) llm = false;

const raw = JSON.parse(readFileSync(path, "utf8"));

const tweets = (raw.tweets?.items || raw.tweets || []).map((t) => {
  const {
    tickers,
    sectors,
    direction,
    horizonVotes,
    instruments,
    directionObvious,
    directionReason,
    llmSide,
    ...rest
  } = t;
  return rest;
});

let analyzed = tweets.map(analyzeTweet);
let recommendations = buildRecommendations(analyzed);

let llmMeta = { enabled: false, model: null, counts: null, table: null };
if (llm) {
  const forLlm = collectTweetsForLlm([...analyzed, ...recommendations]);
  const llmResult = await classifyDirectionsWithLlm(forLlm);
  analyzed = applyDirectionToAnalyzed(analyzed, llmResult, { llmOn: true });
  recommendations = applyDirectionLabels(recommendations, llmResult, {
    llmOn: true,
  });
  const { counts, rows } = formatLlmTable(llmResult.byId);
  llmMeta = { enabled: true, model: llmResult.model, counts, table: rows };
  console.log(
    `LLM sides: Long=${counts.long} Short=${counts.short} Neutral=${counts.neutral}`
  );
} else {
  recommendations = applyDirectionLabels(recommendations, null, {
    llmOn: false,
  });
  analyzed = applyDirectionToAnalyzed(analyzed, null, { llmOn: false });
  console.log("LLM direction: OFF (default)");
}

const classification = classifyTraderStyle(analyzed);
const sectors = summarizeSectors(analyzed);
const tickers = summarizeTickers(recommendations);

console.log(`Reanalyzing ${analyzed.length} tweets from ${path}`);
console.log(
  `Style: ${classification.style.label} (${classification.confidence})`
);
console.log(`Tickers: ${tickers.length}`);

const account = raw.account || "account";
const chartDir = join(__dirname, "output", "charts", account);
console.log("Building 12-month price charts...");
const priceCharts = await buildPriceChartsForReport(recommendations, {
  outDir: chartDir,
  maxCharts: Number(process.env.MAX_CHARTS || 40),
});

const report = {
  ...raw,
  tweets: { count: analyzed.length, items: analyzed },
  classification,
  sectors,
  tickers,
  recommendations,
  priceCharts,
  llm: llmMeta,
  reanalyzedAt: new Date().toISOString(),
};
delete report.backtest;

const outDir = join(__dirname, "output");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(
  outDir,
  `${report.account || "account"}_${report.period?.key || "period"}_re_${stamp}.json`
);
report.outPath = outPath;
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
writeFileSync(join(outDir, "latest.json"), JSON.stringify(report, null, 2), "utf8");
console.log("Saved", outPath);
console.log(`Charts: ${priceCharts.length}`);
