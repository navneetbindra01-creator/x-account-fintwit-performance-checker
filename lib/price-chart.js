/**
 * 12-month price charts with tweet-date markers (scale-correct).
 * - SVG files for inspection
 * - PDFKit drawing for the report
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  fetch12MonthSeries,
  sleep,
  toYahooSymbol,
} from "./price-history.js";
/**
 * Group recommendations into one series per ticker with tweet markers.
 */
export function groupTweetMarkers(recommendations) {
  const map = new Map();
  for (const r of recommendations || []) {
    const sym = (r.ticker || r.symbol || "").toUpperCase();
    if (!sym) continue;
    if (!map.has(sym)) {
      map.set(sym, {
        ticker: sym,
        label: r.label || r.display || sym,
        usedCashtag: !!r.usedCashtag,
        exchange: r.exchange || null,
        name: r.name || null,
        markers: [],
      });
    }
    const g = map.get(sym);
    const day = (r.createdAt || "").slice(0, 10);
    if (!day) continue;
    // dedupe same day
    if (!g.markers.some((m) => m.date === day && m.statusId === r.statusId)) {
      g.markers.push({
        date: day,
        statusId: r.statusId,
        url: r.url,
        direction: r.direction,
        directionObvious: r.directionObvious,
        text: (r.text || "").slice(0, 160),
      });
    }
  }
  for (const g of map.values()) {
    g.markers.sort((a, b) => a.date.localeCompare(b.date));
  }
  return [...map.values()].sort((a, b) => b.markers.length - a.markers.length);
}

/**
 * Pick ~n evenly spaced points for X-axis date labels (daily series).
 */
function pickDateTicks(points, n = 7) {
  if (!points.length) return [];
  if (points.length <= n) return points.map((p) => ({ t: p.t, date: p.date }));
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx =
      i === n - 1
        ? points.length - 1
        : Math.round((i * (points.length - 1)) / (n - 1));
    const p = points[idx];
    out.push({ t: p.t, date: p.date });
  }
  // de-dupe identical dates
  const seen = new Set();
  return out.filter((x) => {
    if (seen.has(x.date)) return false;
    seen.add(x.date);
    return true;
  });
}

/** Format axis date: YYYY-MM-DD for daily chart */
function formatAxisDate(dateStr) {
  return dateStr; // keep full calendar date on daily charts
}

/**
 * Build SVG string — price on Y, dates on X, tweet markers as dots only.
 */
export function seriesToSvg(series, markers, options = {}) {
  const width = options.width || 720;
  const height = options.height || 300;
  const pad = { l: 56, r: 16, t: 28, b: 52 };
  const points = series.points || [];
  if (points.length < 2) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <text x="20" y="40" fill="#666" font-family="sans-serif" font-size="14">No price data</text>
    </svg>`;
  }

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const prices = points.map((p) => p.close);
  let ymin = Math.min(...prices);
  let ymax = Math.max(...prices);
  if (ymin === ymax) {
    ymin *= 0.98;
    ymax *= 1.02;
  }
  const padY = (ymax - ymin) * 0.05 || 1;
  ymin -= padY;
  ymax += padY;

  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;

  const xOf = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * iw;
  const yOf = (p) => pad.t + (1 - (p - ymin) / (ymax - ymin || 1)) * ih;

  const path = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${xOf(p.t).toFixed(1)},${yOf(p.close).toFixed(1)}`
    )
    .join(" ");

  const yTicks = 5;
  let yGrid = "";
  let yLabels = "";
  for (let i = 0; i <= yTicks; i++) {
    const v = ymin + ((ymax - ymin) * i) / yTicks;
    const y = yOf(v);
    yGrid += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${width - pad.r}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`;
    yLabels += `<text x="${pad.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#6b7280" font-family="Helvetica,Arial,sans-serif">${formatPrice(v)}</text>`;
  }

  // Daily chart X-axis: calendar dates along the axis
  const dateTicks = pickDateTicks(points, 7);
  let xGrid = "";
  let xLabels = "";
  for (const tick of dateTicks) {
    const x = xOf(tick.t);
    xGrid += `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${(pad.t + ih).toFixed(1)}" stroke="#f3f4f6" stroke-width="1"/>`;
    xLabels += `<text x="${x.toFixed(1)}" y="${height - 18}" text-anchor="middle" font-size="9" fill="#6b7280" font-family="Helvetica,Arial,sans-serif">${formatAxisDate(tick.date)}</text>`;
  }
  xLabels += `<text x="${(pad.l + iw / 2).toFixed(1)}" y="${height - 4}" text-anchor="middle" font-size="9" fill="#9ca3af" font-family="Helvetica,Arial,sans-serif">Date (daily)</text>`;

  // Tweet markers: dots only (no message text, no date labels on markers)
  let marks = "";
  for (const m of markers || []) {
    const pt = nearestPoint(points, m.date);
    if (!pt) continue;
    const x = xOf(pt.t);
    const y = yOf(pt.close);
    const color =
      m.directionObvious && m.direction === "long"
        ? "#16a34a"
        : m.directionObvious && m.direction === "short"
          ? "#dc2626"
          : "#2563eb";
    marks += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="1.25"/>`;
  }

  const title = options.title || series.yahoo || "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${pad.l}" y="18" font-size="13" font-weight="bold" fill="#111827" font-family="Helvetica,Arial,sans-serif">${escapeXml(title)}</text>
  <text x="${width - pad.r}" y="18" text-anchor="end" font-size="10" fill="#9ca3af" font-family="Helvetica,Arial,sans-serif">12 months · daily close · dots = tweets</text>
  ${yGrid}
  ${xGrid}
  ${yLabels}
  <path d="${path}" fill="none" stroke="#111827" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>
  ${marks}
  ${xLabels}
  <rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="none" stroke="#d1d5db" stroke-width="1"/>
</svg>`;
}

function nearestPoint(points, dateStr) {
  const target = Date.parse(dateStr + "T12:00:00Z");
  if (!Number.isFinite(target)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(p.t - target);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  // only accept if within ~5 trading days
  if (best && bestDist <= 7 * 86400000) return best;
  return best;
}

function formatPrice(v) {
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Draw scale-correct daily chart into PDFKit at (x,y).
 * Tweet markers = dots only (no tweet text, no date labels on dots).
 * X-axis shows calendar dates for the daily series.
 */
/**
 * @param {object} [options]
 * @param {Map<string,string>} [options.linkDests] statusId → named destination
 */
export function drawPriceChartOnPdf(
  doc,
  series,
  markers,
  x,
  y,
  w,
  h,
  title,
  options = {}
) {
  const points = series.points || [];
  const pad = { l: 44, r: 10, t: 22, b: 40 };
  if (points.length < 2) {
    doc.fontSize(10).fillColor("#6b7280").text("No price data", x + 10, y + 20);
    return;
  }

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const prices = points.map((p) => p.close);
  let ymin = Math.min(...prices);
  let ymax = Math.max(...prices);
  if (ymin === ymax) {
    ymin *= 0.98;
    ymax *= 1.02;
  }
  const padY = (ymax - ymin) * 0.05 || 1;
  ymin -= padY;
  ymax += padY;

  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const xOf = (t) => x + pad.l + ((t - t0) / (t1 - t0 || 1)) * iw;
  const yOf = (p) => y + pad.t + (1 - (p - ymin) / (ymax - ymin || 1)) * ih;

  doc.save();
  doc.rect(x, y, w, h).fill("#ffffff");

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#111827")
    .text(title || series.yahoo || "", x + pad.l, y + 4, {
      width: iw * 0.65,
      lineBreak: false,
    });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#9ca3af")
    .text("12 months · daily close · dots = tweets", x + pad.l, y + 4, {
      width: iw,
      align: "right",
      lineBreak: false,
    });

  // horizontal grid + price labels
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = ymin + ((ymax - ymin) * i) / yTicks;
    const yy = yOf(v);
    doc
      .strokeColor("#e5e7eb")
      .lineWidth(0.6)
      .moveTo(x + pad.l, yy)
      .lineTo(x + w - pad.r, yy)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#6b7280")
      .text(formatPrice(v), x + 2, yy - 4, {
        width: pad.l - 6,
        align: "right",
        lineBreak: false,
      });
  }

  // vertical grid at date ticks
  const dateTicks = pickDateTicks(points, 6);
  for (const tick of dateTicks) {
    const xx = xOf(tick.t);
    doc
      .strokeColor("#f3f4f6")
      .lineWidth(0.5)
      .moveTo(xx, y + pad.t)
      .lineTo(xx, y + pad.t + ih)
      .stroke();
  }

  // price path
  doc.strokeColor("#111827").lineWidth(1.4);
  doc.moveTo(xOf(points[0].t), yOf(points[0].close));
  for (let i = 1; i < points.length; i++) {
    doc.lineTo(xOf(points[i].t), yOf(points[i].close));
  }
  doc.stroke();

  // tweet markers: dots only; optional internal PDF links via dest name
  const linkDests = options.linkDests || null; // Map statusId -> dest name
  for (const m of markers || []) {
    const pt = nearestPoint(points, m.date);
    if (!pt) continue;
    const mx = xOf(pt.t);
    const my = yOf(pt.close);
    const color =
      m.directionObvious && m.direction === "long"
        ? "#16a34a"
        : m.directionObvious && m.direction === "short"
          ? "#dc2626"
          : "#2563eb";
    doc.circle(mx, my, 3.5).fillAndStroke(color, "#ffffff");
    // Clickable hit target around the dot → tweet section in this PDF
    const dest =
      (m.statusId && linkDests?.get?.(String(m.statusId))) ||
      (m.statusId ? `tweet_${m.statusId}` : null);
    if (dest) {
      try {
        doc.goTo(mx - 7, my - 7, 14, 14, dest);
      } catch {
        /* ignore link failures */
      }
    }
  }

  // frame
  doc
    .strokeColor("#d1d5db")
    .lineWidth(0.8)
    .rect(x + pad.l, y + pad.t, iw, ih)
    .stroke();

  // X-axis date labels (daily chart calendar dates)
  for (const tick of dateTicks) {
    const xx = xOf(tick.t);
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#6b7280")
      .text(formatAxisDate(tick.date), xx - 28, y + h - 28, {
        width: 56,
        align: "center",
        lineBreak: false,
      });
  }
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#9ca3af")
    .text("Date (daily)", x + pad.l, y + h - 12, {
      width: iw,
      align: "center",
      lineBreak: false,
    });

  doc.restore();
}

/**
 * Fetch charts for all tickers in recommendations; write SVG files.
 * @returns {Promise<Array>} chart payloads for PDF/JSON
 */
export async function buildPriceChartsForReport(recommendations, options = {}) {
  const outDir = options.outDir;
  const groups = groupTweetMarkers(recommendations);
  const maxCharts = options.maxCharts ?? 40;
  const charts = [];

  if (outDir) mkdirSync(outDir, { recursive: true });

  let n = 0;
  for (const g of groups) {
    if (n >= maxCharts) break;
    try {
      const series = await fetch12MonthSeries(g.ticker);
      await sleep(150);
      const title = `${g.usedCashtag ? "$" : ""}${g.ticker}${g.exchange ? " · " + g.exchange : ""} · 12 months`;
      const svg = seriesToSvg(series, g.markers, { title });
      let svgPath = null;
      if (outDir) {
        svgPath = join(outDir, `${g.ticker.replace(/[^A-Za-z0-9._-]/g, "_")}.svg`);
        writeFileSync(svgPath, svg, "utf8");
      }
      charts.push({
        ticker: g.ticker,
        yahoo: series.yahoo,
        label: g.label,
        markers: g.markers,
        points: series.points,
        svgPath,
        title,
        error: null,
      });
      console.log(
        `  Chart ${g.ticker} (${series.yahoo}): ${series.points.length} days, ${g.markers.length} tweet marker(s)`
      );
      n += 1;
    } catch (e) {
      console.warn(`  Chart ${g.ticker}: ${e.message}`);
      charts.push({
        ticker: g.ticker,
        yahoo: toYahooSymbol(g.ticker),
        label: g.label,
        markers: g.markers,
        points: [],
        svgPath: null,
        title: g.ticker,
        error: e.message,
      });
      n += 1;
    }
  }
  return charts;
}
