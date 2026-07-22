/**
 * Download tweet chart images and OCR them for ticker / instrument labels.
 */
import { createWorker } from "tesseract.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  isTradingChartOcr,
  scoreTradingChartOcr,
  extractHighConfidenceChartTickers,
} from "./chart-detect.js";
import { KNOWN_SYMBOLS_FOR_OCR } from "./extract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = join(__dirname, "..", "output", "media");

async function downloadImage(url, dest) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

/**
 * OCR images on tweets that have media and little/no ticker text.
 * Mutates tweets in place: imageOcr, chartTickers, mediaLocal
 */
export async function enrichTweetsWithImageOcr(tweets, options = {}) {
  const maxImages = options.maxImages ?? 80;
  const forceAllMedia = options.forceAllMedia ?? false;

  mkdirSync(MEDIA_DIR, { recursive: true });

  const candidates = tweets.filter((t) => {
    if (!t.hasMedia && !(t.media?.length > 0)) return false;
    if (forceAllMedia) return true;
    const text = t.text || "";
    // prioritize empty/short captions or commodity bids without symbols
    if (text.length < 12) return true;
    if (!/\$[A-Za-z]{1,5}\b/.test(text) && t.media?.length) return true;
    return false;
  });

  console.log(
    `Image OCR: ${candidates.length} candidate tweets (cap ${maxImages} images)`
  );

  const worker = await createWorker("eng");
  let processed = 0;

  try {
    for (const t of candidates) {
      if (processed >= maxImages) break;
      const ocrChunks = [];
      const chartTickers = new Set();
      const localFiles = [];

      for (const m of t.media || []) {
        if (processed >= maxImages) break;
        try {
          const ext = m.src.includes("format=jpg") ? "jpg" : "png";
          const dest = join(MEDIA_DIR, `${t.statusId}_${processed}.${ext}`);
          if (!existsSync(dest)) {
            await downloadImage(m.src, dest);
          }
          localFiles.push(dest);
          const {
            data: { text },
          } = await worker.recognize(dest);
          const cleaned = (text || "").replace(/\s+/g, " ").trim();
          if (cleaned) {
            ocrChunks.push(cleaned);
            const chartScore = scoreTradingChartOcr(cleaned);
            if (chartScore.isChart) {
              for (const hit of extractHighConfidenceChartTickers(
                cleaned,
                KNOWN_SYMBOLS_FOR_OCR
              )) {
                const sym = typeof hit === "string" ? hit : hit.symbol;
                if (sym) chartTickers.add(sym);
                if (typeof hit === "object" && hit.exchange) {
                  t.chartExchange = t.chartExchange || hit.exchange;
                }
              }
            } else {
              console.log(
                `  @${t.statusId}: skip non-chart image (score=${chartScore.score})`
              );
            }
          }
          // alt text only if it looks like a chart label (has exchange/ticker pattern)
          if (m.alt && isTradingChartOcr(m.alt)) {
            for (const hit of extractHighConfidenceChartTickers(
              m.alt,
              KNOWN_SYMBOLS_FOR_OCR
            )) {
              const sym = typeof hit === "string" ? hit : hit.symbol;
              if (sym) chartTickers.add(sym);
            }
          }
          processed += 1;
          if (processed % 5 === 0) {
            console.log(`  OCR progress: ${processed} images...`);
          }
        } catch (e) {
          console.warn(`  OCR skip ${t.statusId}: ${e.message}`);
        }
      }

      t.mediaLocal = localFiles;
      t.imageOcr = ocrChunks.join(" | ").slice(0, 4000);
      const combinedScore = scoreTradingChartOcr(t.imageOcr);
      t.imageIsChart = combinedScore.isChart;
      t.imageChartScore = combinedScore.score;
      // Only keep tickers if the combined OCR looks like a chart
      t.chartTickers = combinedScore.isChart ? [...chartTickers] : [];
      if (!combinedScore.isChart) {
        // Keep OCR text for debugging but do not treat as chart symbols
        t.chartTickers = [];
      }
      if (t.chartTickers.length) {
        console.log(
          `  @${t.statusId}: chart tickers → ${t.chartTickers.join(", ")} (score=${combinedScore.score})`
        );
      }
    }
  } finally {
    await worker.terminate();
  }

  console.log(`Image OCR done. Processed ${processed} images.`);
  return tweets;
}
