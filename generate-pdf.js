/**
 * Generate a PDF report from analysis JSON.
 * Usage: node generate-pdf.js [path/to/analysis.json] [out.pdf]
 *
 * Includes 12-month price charts (scale-correct) with tweet-date markers.
 * If report.priceCharts is missing, charts are built on the fly.
 */
import PDFDocument from "pdfkit";
import { createWriteStream, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildPriceChartsForReport,
  drawPriceChartOnPdf,
} from "./lib/price-chart.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function argPath() {
  return process.argv[2] || join(__dirname, "output", "latest.json");
}

function outPath(report) {
  if (process.argv[3]) return process.argv[3];
  const dir = join(__dirname, "output");
  mkdirSync(dir, { recursive: true });
  const name = `${report.account || "account"}_${report.period?.key || "period"}_report.pdf`;
  return join(dir, name);
}

function sectionTitle(doc, text) {
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text(text);
  doc
    .moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor("#d1d5db")
    .stroke();
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(10).fillColor("#111827");
}

function kv(doc, key, val) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font("Helvetica-Bold").text(key, x, doc.y, { continued: true, width: w });
  doc.font("Helvetica").text(`  ${val}`, { width: w });
}

function ensureSpace(doc, need = 80) {
  if (doc.y + need > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

async function main() {
  const report = JSON.parse(readFileSync(argPath(), "utf8"));
  const pdfPath = outPath(report);

  // Ensure price charts exist
  let charts = report.priceCharts;
  if (!charts?.length && report.recommendations?.length) {
    console.log("Building 12-month price charts for PDF...");
    const chartDir = join(
      __dirname,
      "output",
      "charts",
      report.account || "account"
    );
    charts = await buildPriceChartsForReport(report.recommendations, {
      outDir: chartDir,
      maxCharts: Number(process.env.MAX_CHARTS || 40),
    });
  }

  const doc = new PDFDocument({
    margin: 50,
    size: "LETTER",
    info: {
      Title: `X Trader Analysis — @${report.account}`,
      Author: "x-edge-search analyzer",
      Subject: "Account trader style, recommendations, 12-month charts",
    },
  });
  const stream = createWriteStream(pdfPath);
  doc.pipe(stream);

  // Header
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor("#0f172a")
    .text("X Account Trader Analysis");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#475569")
    .text(
      `@${report.account}  ·  ${report.profileUrl || "https://x.com/" + report.account}`
    );
  if (report.batch) {
    doc.text(
      `Batch ${report.batch.index}/${report.batch.total}: ${report.batch.label}  ·  Period ${report.period?.key || ""}`
    );
  } else {
    doc.text(
      `Period: ${report.period?.label || ""} (${report.period?.key || ""})  ·  Since ${report.since || ""}`
    );
  }
  if (report.untilInclusive) {
    doc.text(`Window: ${report.since || "…"} → ${report.untilInclusive}`);
  }
  doc.text(
    `Generated: ${new Date(report.reanalyzedAt || report.scrapedAt || Date.now()).toUTCString()}`
  );

  // Style
  sectionTitle(doc, "1. Trader style classification");
  const c = report.classification || {};
  kv(
    doc,
    "Style:",
    `${c.style?.label || "n/a"} — ${c.style?.description || ""}`
  );
  kv(doc, "Confidence:", c.confidence || "n/a");
  kv(doc, "Method:", c.method || "n/a");
  kv(
    doc,
    "Tweets analyzed:",
    String(report.tweets?.count ?? report.tweets?.items?.length ?? 0)
  );
  if (c.scores) {
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").text("Style score breakdown:");
    doc.font("Helvetica");
    for (const [k, v] of Object.entries(c.scores)) {
      doc.text(`   • ${k}: ${v}`);
    }
  }

  // Sectors
  sectionTitle(doc, "2. Sector mentions");
  const sectors = report.sectors || [];
  if (!sectors.length) doc.text("No sector keywords detected in the sample.");
  else {
    for (const s of sectors.slice(0, 15)) {
      doc.text(`   • ${s.sector}: ${s.count} mention(s)`);
    }
  }

  // Instruments
  sectionTitle(doc, "3. Stock / instrument recommendations");
  doc
    .font("Helvetica-Oblique")
    .fillColor("#475569")
    .text(
      "Rule: $cashtag is shown only when the cashtag appears in the tweet. Otherwise the instrument is named from tweet text and/or chart image (no invented cashtag)."
    )
    .fillColor("#111827")
    .font("Helvetica");
  doc.moveDown(0.3);
  const tickers = report.tickers || [];
  if (!tickers.length) {
    doc.text("Few or no instruments were extracted.");
  } else {
    doc.text("Instrument | mentions | long | short | mention-only");
    doc.moveDown(0.2);
    for (const t of tickers.slice(0, 30)) {
      const label = t.label || t.display || t.ticker;
      doc.text(
        `${label}  m=${t.mentions}  L=${t.long}  S=${t.short}  N=${t.mention}`
      );
    }
  }

  // Mentions + optional LLM directional calls (named destinations for chart links)
  ensureSpace(doc, 100);
  sectionTitle(doc, "4. Mentions & directional calls");
  const llmOn = !!report.llm?.enabled;
  doc
    .font("Helvetica-Oblique")
    .fillColor("#475569")
    .text(
      llmOn
        ? `LLM direction ON (${report.llm?.model || "model"}). Long/Short/Neutral from bulk LLM. Counts: L=${report.llm?.counts?.long ?? "?"} S=${report.llm?.counts?.short ?? "?"} N=${report.llm?.counts?.neutral ?? "?"}. Chart dots link here.`
        : "LLM direction OFF (default). No Long/Short labels — instruments and tweets only. Enable with --llm (XAI_API_KEY). Chart dots link here."
    )
    .fillColor("#111827")
    .font("Helvetica");
  doc.moveDown(0.3);

  const recs = report.recommendations || [];
  // Destinations for in-PDF chart → tweet navigation
  const linkDests = new Map(); // statusId -> dest name
  const destSeen = new Set();

  function writeTweetEntry(r, { showSide }) {
    ensureSpace(doc, 70);
    const day = (r.createdAt || "").slice(0, 10);
    const lvl =
      r.level != null
        ? ` @ ${r.level}`
        : r.levels?.[0]?.level != null
          ? ` @ ${r.levels[0].level}`
          : "";
    const cond = r.conditional ? " (conditional / buy zone)" : "";
    const label = r.label || r.display || r.ticker;
    const sid = r.statusId ? String(r.statusId) : null;
    const dest = sid ? `tweet_${sid}` : null;

    // Anchor once per tweet id so multiple instruments on the same post share it
    if (dest && !destSeen.has(dest)) {
      doc.addNamedDestination(dest);
      destSeen.add(dest);
      linkDests.set(sid, dest);
    }

    const head = showSide
      ? `${day}  ${r.direction.toUpperCase()}  ${label}${lvl}${cond}`
      : `${day}  ${label}`;
    doc.font("Helvetica-Bold").fillColor("#111827").text(head);
    doc
      .font("Helvetica")
      .fillColor("#334155")
      .text(
        (r.text || "").replace(/\s+/g, " ").slice(0, 280) ||
          "(no text — see image/parent)",
        {
          width:
            doc.page.width - doc.page.margins.left - doc.page.margins.right,
        }
      );
    doc.fillColor("#111827");
    if (r.url) {
      doc.fillColor("#2563eb").fontSize(9).text(r.url, { link: r.url });
      doc.fontSize(10).fillColor("#111827");
    }
    doc.moveDown(0.3);
  }

  const obvious = recs.filter(
    (r) =>
      r.directionObvious &&
      (r.direction === "long" || r.direction === "short")
  );
  const mentions = recs.filter(
    (r) =>
      !(
        r.directionObvious &&
        (r.direction === "long" || r.direction === "short")
      )
  );

  if (!recs.length) {
    doc.text("No instruments extracted.");
  } else {
    if (obvious.length) {
      doc.font("Helvetica-Bold").text("Obvious long/short:");
      doc.font("Helvetica");
      for (const r of obvious) writeTweetEntry(r, { showSide: true });
    }

    if (mentions.length) {
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").text("Mentions (no clear long/short):");
      doc.font("Helvetica");
      for (const r of mentions) writeTweetEntry(r, { showSide: false });
    }
  }

  // Safety: any chart marker whose tweet was not written yet (should be rare)
  for (const ch of charts || []) {
    for (const m of ch.markers || []) {
      const sid = m.statusId ? String(m.statusId) : null;
      if (!sid || destSeen.has(`tweet_${sid}`)) continue;
      const r =
        recs.find((x) => String(x.statusId) === sid) || {
          statusId: sid,
          createdAt: m.date,
          label: ch.ticker,
          text: m.text,
          url: m.url,
          direction: m.direction,
          directionObvious: m.directionObvious,
        };
      writeTweetEntry(r, {
        showSide: !!(
          r.directionObvious &&
          (r.direction === "long" || r.direction === "short")
        ),
      });
    }
  }

  // Price charts
  ensureSpace(doc, 40);
  sectionTitle(doc, "5. Twelve-month price charts with tweet markers");
  doc
    .font("Helvetica")
    .fillColor("#111827")
    .text("Dot legend (click a dot to jump to that tweet in section 4):");
  doc.moveDown(0.2);
  // color key
  const legendY = doc.y;
  const lx = doc.page.margins.left;
  doc.circle(lx + 6, legendY + 4, 4).fill("#16a34a");
  doc
    .fillColor("#111827")
    .fontSize(9)
    .text(
      llmOn
        ? "Green = LLM Long"
        : "Green = Long (only when --llm is on)",
      lx + 14,
      legendY
    );
  doc.circle(lx + 6, doc.y + 4, 4).fill("#dc2626");
  doc
    .fillColor("#111827")
    .text(
      llmOn
        ? "Red = LLM Short"
        : "Red = Short (only when --llm is on)",
      lx + 14,
      doc.y - 2
    );
  doc.circle(lx + 6, doc.y + 4, 4).fill("#2563eb");
  doc
    .fillColor("#111827")
    .text(
      llmOn
        ? "Blue = LLM Neutral / no trade side"
        : "Blue = tweet day for this symbol (LLM off — all markers are blue)",
      lx + 14,
      doc.y - 2,
      {
        width:
          doc.page.width - doc.page.margins.left - doc.page.margins.right - 14,
      }
    );
  doc.moveDown(0.35);
  doc
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor("#475569")
    .text(
      "Each chart is scale-correct (daily close, last 12 months). X-axis = calendar dates. Dots mark tweet days only (no tweet text on the chart)."
    )
    .fillColor("#111827")
    .font("Helvetica")
    .fontSize(10);
  doc.moveDown(0.4);

  const chartList = charts || [];
  if (!chartList.length) {
    doc.text("No charts available.");
  } else {
    for (const ch of chartList) {
      ensureSpace(doc, 220);
      const label = ch.label || ch.ticker;
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#111827")
        .text(label);
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#64748b")
        .text(
          `Yahoo: ${ch.yahoo || ch.ticker}  ·  ${ch.markers?.length || 0} tweet marker(s)  ·  click dots → section 4` +
            (ch.error ? `  ·  error: ${ch.error}` : "")
        );
      doc.fillColor("#111827");

      const chartW =
        doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const chartH = 190;
      const chartY = doc.y + 4;
      if (ch.points?.length >= 2) {
        drawPriceChartOnPdf(
          doc,
          { points: ch.points, yahoo: ch.yahoo },
          ch.markers || [],
          doc.page.margins.left,
          chartY,
          chartW,
          chartH,
          ch.title || ch.ticker,
          { linkDests }
        );
        doc.y = chartY + chartH + 10;
      } else {
        doc
          .fontSize(10)
          .fillColor("#6b7280")
          .text(ch.error || "No price series available.");
        doc.fillColor("#111827");
        doc.moveDown(0.4);
      }
      doc.moveDown(0.35);
    }
  }

  // Method notes
  ensureSpace(doc, 120);
  sectionTitle(doc, "6. Methodology & limitations");
  const notes = report.notes || [
    "Style classification uses language cues across posts.",
    "Display: $cashtag only when present in the tweet text.",
    "Long/Short is not regex-based. Default OFF = Neutral only. Optional --llm bulk-classifies Long/Short/Neutral via SpaceXAI (XAI_API_KEY).",
    "12-month charts use Yahoo Finance daily closes; dots = tweet dates (clickable to section 4).",
    "Scroll-based scrapes may be incomplete for very active accounts.",
    "This is research tooling only — not investment advice.",
  ];
  for (const n of notes) {
    doc.text(`• ${n}`, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    });
    doc.moveDown(0.25);
  }

  doc.moveDown(1);
  doc
    .fontSize(8)
    .fillColor("#94a3b8")
    .text(
      "Confidential research output · Generated by x-edge-search analyze-account",
      { align: "center" }
    );

  doc.end();
  await new Promise((res, rej) => {
    stream.on("finish", res);
    stream.on("error", rej);
  });
  console.log("PDF written:", pdfPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
