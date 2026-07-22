/**
 * Analyze an X account for trader style, recommendations, and 12-month charts.
 *
 * Multi-month periods run as 1-month batches (from today going back).
 * Each batch produces its own JSON + PDF (tweets only in that window).
 *
 * Usage:
 *   node analyze-account.js --account RockBtmEntries
 *   node analyze-account.js --account RockBtmEntries --period 2m
 *   node analyze-account.js --account RockBtmEntries --period 6m --llm
 *
 * Periods: 10d | 30d | 1m (default) | 2m | 3m | 6m | 1y | 3y
 *
 * LLM direction (default OFF):
 *   --llm              enable bulk LLM Long/Short/Neutral (needs XAI_API_KEY)
 *   --no-llm           force off
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { launchChromeSession } from "./lib/chrome.js";
import { resolvePeriod, buildMonthBatches } from "./lib/periods.js";
import {
  normalizeHandle,
  scrapeUserTweets,
  resolveParentTweets,
} from "./lib/scrape-timeline.js";
import { formatRecHeadline } from "./lib/format.js";
import { analyzeTweet, buildRecommendations } from "./lib/extract.js";
import {
  classifyTraderStyle,
  summarizeSectors,
  summarizeTickers,
} from "./lib/classify.js";
import { enrichTweetsWithImageOcr } from "./lib/image-ocr.js";
import { buildPriceChartsForReport } from "./lib/price-chart.js";
import {
  collectTweetsForLlm,
  classifyDirectionsWithLlm,
  applyDirectionLabels,
  applyDirectionToAnalyzed,
  formatLlmTable,
} from "./lib/llm-direction.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let llm = process.env.USE_LLM === "1" || process.env.USE_LLM === "true";
  const out = {
    account: null,
    period: "1m",
    maxScrolls: 120,
    llm,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account" || a === "-a") out.account = argv[++i];
    else if (a === "--period" || a === "-p") out.period = argv[++i];
    else if (a === "--max-scrolls") out.maxScrolls = Number(argv[++i]);
    else if (a === "--llm") out.llm = true;
    else if (a === "--no-llm") out.llm = false;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-") && !out.account) out.account = a;
  }
  return out;
}

function printReport(report) {
  const { account, period, classification, tweets, tickers, sectors } = report;

  console.log("\n" + "=".repeat(60));
  console.log(" X ACCOUNT TRADER ANALYSIS");
  console.log("=".repeat(60));
  console.log(` Account:     @${account}`);
  console.log(` Period:      ${period.label} (${period.key})`);
  if (report.batch) {
    console.log(
      ` Batch:       ${report.batch.index}/${report.batch.total} · ${report.batch.label}`
    );
  }
  console.log(` Since:       ${report.since}`);
  if (report.untilInclusive) console.log(` Until:       ${report.untilInclusive}`);
  console.log(` Tweets:      ${tweets.count}`);
  console.log(
    ` LLM sides:   ${report.llm?.enabled ? "ON (" + (report.llm.model || "") + ")" : "OFF (default)"}`
  );
  console.log("-".repeat(60));
  console.log(" TRADER STYLE");
  console.log(
    `  ${classification.style.label} — ${classification.style.description}`
  );
  console.log(`  Confidence: ${classification.confidence}`);
  console.log(`  Style scores: ${JSON.stringify(classification.scores)}`);
  console.log("-".repeat(60));
  console.log(" SECTORS");
  if (!sectors.length) console.log("  (none)");
  else
    for (const s of sectors.slice(0, 12))
      console.log(`  ${s.sector}: ${s.count}`);
  console.log("-".repeat(60));
  console.log(" INSTRUMENTS");
  if (!tickers.length) console.log("  (none)");
  else {
    for (const t of tickers.slice(0, 20)) {
      console.log(
        `  ${t.label || t.display || t.ticker}  m=${t.mentions} L=${t.long} S=${t.short} N=${t.mention}`
      );
    }
  }
  if (report.llm?.enabled && report.llm?.counts) {
    console.log("-".repeat(60));
    console.log(
      ` LLM: Long=${report.llm.counts.long || 0} Short=${report.llm.counts.short || 0} Neutral=${report.llm.counts.neutral || 0}`
    );
  }
  const charts = report.priceCharts || [];
  console.log("-".repeat(60));
  console.log(` CHARTS: ${charts.length}`);
  const allRecs = report.recommendations || [];
  const dirRecs = allRecs.filter((r) => r.directionObvious);
  for (const r of dirRecs.slice(0, 10)) {
    console.log("  " + formatRecHeadline(r));
  }
  console.log("=".repeat(60));
  console.log(` JSON: ${report.outPath}`);
  if (report.pdfPath) console.log(` PDF:  ${report.pdfPath}`);
  console.log("");
}

function runGeneratePdf(jsonPath, pdfPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(__dirname, "generate-pdf.js"), jsonPath, pdfPath],
      { stdio: "inherit", cwd: __dirname }
    );
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`generate-pdf exited ${code}`));
    });
    child.on("error", reject);
  });
}

/**
 * Process one date-window batch (scrape → analyze → optional LLM → charts → files).
 */
async function processBatch({ page, handle, batch, period, args, outDir }) {
  console.log("\n" + "#".repeat(60));
  console.log(
    `# BATCH ${batch.index}/${batch.total}: ${batch.label}`
  );
  console.log("#".repeat(60));

  const scraped = await scrapeUserTweets(page, handle, {
    since: batch.since,
    until: batch.until,
    untilInclusive: batch.untilInclusive,
    maxScrolls: args.maxScrolls,
    days: batch.days,
  });

  console.log(`Collected ${scraped.tweets.length} tweets in window.`);

  if (process.env.SKIP_OCR !== "1") {
    await enrichTweetsWithImageOcr(scraped.tweets, {
      maxImages: Number(process.env.MAX_OCR_IMAGES || 50),
    });
  }

  if (process.env.SKIP_PARENTS !== "1") {
    await resolveParentTweets(page, scraped.tweets, {
      maxParents: Number(process.env.MAX_PARENTS || 25),
      maxParentOcrImages: Number(process.env.MAX_PARENT_OCR || 15),
    });
  }

  let analyzed = scraped.tweets.map(analyzeTweet);
  let recommendations = buildRecommendations(analyzed);

  let llmMeta = { enabled: false, model: null, counts: null, table: null };
  if (args.llm) {
    const forLlm = collectTweetsForLlm([...analyzed, ...recommendations]);
    if (forLlm.length === 0) {
      console.log("LLM: no tweets to classify in this batch.");
    } else {
      const llmResult = await classifyDirectionsWithLlm(forLlm);
      analyzed = applyDirectionToAnalyzed(analyzed, llmResult, { llmOn: true });
      recommendations = applyDirectionLabels(recommendations, llmResult, {
        llmOn: true,
      });
      const { counts, rows } = formatLlmTable(llmResult.byId);
      llmMeta = {
        enabled: true,
        model: llmResult.model,
        counts,
        table: rows,
      };
      console.log(
        `LLM sides: Long=${counts.long} Short=${counts.short} Neutral=${counts.neutral}`
      );
    }
  } else {
    recommendations = applyDirectionLabels(recommendations, null, {
      llmOn: false,
    });
    analyzed = applyDirectionToAnalyzed(analyzed, null, { llmOn: false });
  }

  const classification = classifyTraderStyle(analyzed);
  const sectors = summarizeSectors(analyzed);
  const tickers = summarizeTickers(recommendations);

  const chartDir = join(outDir, "charts", handle, batch.key);
  console.log("Building 12-month price charts...");
  const priceCharts = await buildPriceChartsForReport(recommendations, {
    outDir: chartDir,
    maxCharts: Number(process.env.MAX_CHARTS || 40),
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileBase =
    batch.total > 1
      ? `${handle}_batch${batch.index}of${batch.total}_${batch.key}`
      : `${handle}_${period.key}_${batch.key}`;
  const jsonPath = join(outDir, `${fileBase}_${stamp}.json`);
  const pdfPath = join(outDir, `${fileBase}.pdf`);

  const report = {
    account: handle,
    profileUrl: `https://x.com/${handle}`,
    period: {
      key: period.key,
      label: period.label,
      days: period.days,
      batchWindow: batch.label,
    },
    batch: {
      index: batch.index,
      total: batch.total,
      since: batch.since,
      until: batch.until,
      untilInclusive: batch.untilInclusive,
      label: batch.label,
      key: batch.key,
    },
    since: batch.since,
    untilInclusive: batch.untilInclusive,
    query: scraped.query,
    scrapedAt: new Date().toISOString(),
    tweets: {
      count: scraped.tweets.length,
      items: analyzed,
    },
    classification,
    sectors,
    tickers,
    recommendations,
    priceCharts,
    llm: llmMeta,
    outPath: jsonPath,
    pdfPath,
    notes: [
      "Each multi-month run produces one report per 30-day batch (from today going back).",
      "This file only includes tweets in the batch date range.",
      "Long/Short only when --llm is on (SpaceXAI / XAI_API_KEY); default off.",
      "12-month charts show price history with dots on tweet dates in this batch.",
    ],
  };

  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(
    join(outDir, "latest.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );

  try {
    await runGeneratePdf(jsonPath, pdfPath);
    report.pdfPath = pdfPath;
  } catch (e) {
    console.warn("PDF generation failed:", e.message);
  }

  printReport(report);
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.account) {
    console.log(`Usage:
  node analyze-account.js --account RockBtmEntries
  node analyze-account.js --account RockBtmEntries --period 2m
  node analyze-account.js --account RockBtmEntries --period 6m --llm

Periods: 10d | 30d | 1m (default) | 2m | 3m | 6m | 1y | 3y
Multi-month periods → one 30-day batch per month, separate PDF each.
LLM: --llm (default off) needs XAI_API_KEY
`);
    process.exit(args.help ? 0 : 1);
  }

  const handle = normalizeHandle(args.account);
  const period = resolvePeriod(args.period);
  const batches = buildMonthBatches(period);

  console.log(`Account: @${handle}`);
  console.log(`Period:  ${period.label} (${period.key})`);
  console.log(`Batches: ${batches.length} × ~1 month`);
  for (const b of batches) {
    console.log(`  ${b.index}/${b.total}: ${b.label}`);
  }
  console.log(`LLM:     ${args.llm ? "ON" : "OFF (default)"}`);

  const outDir = join(__dirname, "output");
  mkdirSync(outDir, { recursive: true });

  const { browser, page } = await launchChromeSession();
  const reports = [];

  try {
    for (const batch of batches) {
      const report = await processBatch({
        page,
        handle,
        batch,
        period,
        args,
        outDir,
      });
      reports.push({
        batch: report.batch,
        tweets: report.tweets.count,
        json: report.outPath,
        pdf: report.pdfPath,
        llm: report.llm?.counts || null,
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log("\n" + "=".repeat(60));
  console.log(" ALL BATCHES COMPLETE");
  console.log("=".repeat(60));
  for (const r of reports) {
    console.log(
      ` Batch ${r.batch.index}/${r.batch.total} ${r.batch.label}: ${r.tweets} tweets`
    );
    console.log(`   JSON: ${r.json}`);
    console.log(`   PDF:  ${r.pdf || "(none)"}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
