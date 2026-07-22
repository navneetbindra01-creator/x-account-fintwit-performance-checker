/**
 * Render sample report screenshots for README from real analysis JSON + SVG charts.
 * Usage: node scripts/render-readme-shots.js
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { pathToFileURL } from "url";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "docs", "screenshots");
const tmpDir = join(outDir, "_tmp");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadReport(prefix) {
  const f = readdirSync(join(root, "output")).find(
    (x) => x.startsWith(prefix) && x.endsWith(".json")
  );
  if (!f) throw new Error("No JSON for " + prefix);
  return JSON.parse(readFileSync(join(root, "output", f), "utf8"));
}

function topInstruments(report, n = 12) {
  const byT = new Map();
  for (const r of report.recommendations || []) {
    const t = (r.ticker || r.symbol || "").toUpperCase();
    if (!t) continue;
    if (!byT.has(t)) {
      byT.set(t, { t, label: r.label || t, L: 0, S: 0, N: 0, m: 0 });
    }
    const g = byT.get(t);
    g.m++;
    const d = (r.direction || "Neutral").toLowerCase();
    if (d === "long") g.L++;
    else if (d === "short") g.S++;
    else g.N++;
  }
  return [...byT.values()].sort((a, b) => b.m - a.m).slice(0, n);
}

function countDirs(report) {
  const llmCounts = report.llm?.counts;
  if (llmCounts) {
    return {
      L: llmCounts.long ?? llmCounts.Long ?? 0,
      S: llmCounts.short ?? llmCounts.Short ?? 0,
      N: llmCounts.neutral ?? llmCounts.Neutral ?? 0,
    };
  }
  let L = 0,
    S = 0,
    N = 0;
  for (const r of report.recommendations || []) {
    const d = (r.direction || "Neutral").toLowerCase();
    if (d === "long") L++;
    else if (d === "short") S++;
    else N++;
  }
  return { L, S, N };
}

function sectorLine(report) {
  const c = report.classification || {};
  const sectors = report.sectors || c.sectors || {};
  if (Array.isArray(sectors)) {
    return sectors
      .slice(0, 6)
      .map((s) => {
        if (typeof s === "string") return s;
        return `${s.name || s.sector || s.label || "?"}: ${s.count ?? s.n ?? s.mentions ?? ""}`;
      })
      .join(" · ");
  }
  return Object.entries(sectors)
    .sort((a, b) => {
      const av = typeof a[1] === "number" ? a[1] : a[1]?.count || 0;
      const bv = typeof b[1] === "number" ? b[1] : b[1]?.count || 0;
      return bv - av;
    })
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v : v?.count ?? JSON.stringify(v)}`)
    .join(" · ");
}

function buildSummaryHtml(report) {
  const c = report.classification || {};
  const top = topInstruments(report);
  const { L, S, N } = countDirs(report);
  const recs = (report.recommendations || [])
    .filter((r) => {
      const d = (r.direction || "").toLowerCase();
      return d === "long" || d === "short";
    })
    .slice(0, 8);
  const tweetCount = Array.isArray(report.tweets)
    ? report.tweets.length
    : report.tweets && typeof report.tweets === "object"
      ? Object.keys(report.tweets).length
      : report.llm?.table?.length ??
        report.tweetCount ??
        report.tweetsAnalyzed ??
        "—";
  const styleObj = typeof c.style === "object" && c.style ? c.style : null;
  const styleLabel = styleObj
    ? `${styleObj.label || styleObj.id || "—"}${styleObj.description ? " — " + styleObj.description : ""}`
    : c.label || c.primary || c.styleLabel || c.style || "—";
  const scores = c.scores || c.styleScores || {};

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: Helvetica, Arial, sans-serif; background:#e5e7eb; color:#0f172a; }
  .page { width: 820px; margin: 24px auto; background:#fff; padding: 40px 44px;
          box-shadow: 0 10px 40px rgba(0,0,0,.12); min-height: 1040px; }
  h1 { font-size: 26px; margin: 0 0 6px; color:#0f172a; }
  .sub { color:#475569; font-size: 13px; line-height: 1.55; margin-bottom: 18px; }
  h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
  .kv { font-size: 12.5px; margin: 4px 0; }
  .kv b { display:inline-block; min-width: 110px; }
  table { width:100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th, td { text-align:left; padding: 7px 8px; border-bottom: 1px solid #e5e7eb; }
  th { background:#f8fafc; color:#334155; font-weight:600; }
  .stats { display:flex; gap:12px; margin: 12px 0 4px; }
  .stat { flex:1; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:14px; text-align:center; }
  .stat .n { font-size: 24px; font-weight:700; }
  .stat .l { font-size: 11px; color:#64748b; margin-top:3px; text-transform:uppercase; letter-spacing:.04em; }
  .badge { display:inline-block; background:#0f172a; color:#fff; font-size:11px; padding:3px 9px; border-radius:6px; margin-bottom:12px; }
  .rec { font-size: 12px; padding: 8px 0; border-bottom:1px solid #f1f5f9; }
  .rec .d { font-weight:700; width: 56px; display:inline-block; }
  .rec .d.L { color:#166534; } .rec .d.S { color:#991b1b; }
  .muted { color:#64748b; font-size:11px; }
</style></head><body><div class="page">
  <div class="badge">Sample PDF report · overview</div>
  <h1>X Account Trader Analysis</h1>
  <div class="sub">
    @${esc(report.account)} · https://x.com/${esc(report.account)}<br/>
    ${
      report.batch
        ? `Batch ${esc(report.batch.index)}/${esc(report.batch.total)}: ${esc(report.batch.label)} · Period ${esc(report.period?.key)}`
        : esc(report.period?.label)
    }<br/>
    Window: ${esc(report.since)} → ${esc(report.untilInclusive || report.until)} · Tweets: ${esc(tweetCount)}
  </div>

  <h2>1. Trader style classification</h2>
  <div class="kv"><b>Style</b> ${esc(styleLabel)}</div>
  <div class="kv"><b>Confidence</b> ${esc(c.confidence || "—")}</div>
  <div class="kv"><b>Scores</b> <span class="muted">${esc(JSON.stringify(scores))}</span></div>

  <h2>2. Sectors &amp; instruments</h2>
  <div class="kv"><b>Sectors</b> ${esc(sectorLine(report) || "—")}</div>
  <table>
    <thead><tr><th>Instrument</th><th>Mentions</th><th>Long</th><th>Short</th><th>Neutral</th></tr></thead>
    <tbody>
      ${top
        .map(
          (g) =>
            `<tr><td>${esc(g.label)}</td><td>${g.m}</td><td>${g.L}</td><td>${g.S}</td><td>${g.N}</td></tr>`
        )
        .join("")}
    </tbody>
  </table>

  <h2>3. LLM direction summary</h2>
  <div class="stats">
    <div class="stat"><div class="n" style="color:#166534">${L}</div><div class="l">Long</div></div>
    <div class="stat"><div class="n" style="color:#991b1b">${S}</div><div class="l">Short</div></div>
    <div class="stat"><div class="n" style="color:#475569">${N}</div><div class="l">Neutral</div></div>
  </div>

  <h2>4. Sample directional calls</h2>
  ${
    recs
      .map((r) => {
        const d = (r.direction || "").toLowerCase() === "long" ? "L" : "S";
        const day = (r.createdAt || "").slice(0, 10);
        const text = (r.text || "").slice(0, 110);
        return `<div class="rec"><span class="d ${d}">${d === "L" ? "LONG" : "SHORT"}</span> ${esc(r.label || r.ticker)} <span class="muted">· ${esc(day)}</span><br/><span class="muted">${esc(text)}${(r.text || "").length > 110 ? "…" : ""}</span></div>`;
      })
      .join("") ||
    '<div class="muted">No directional calls in this window.</div>'
  }

  <div class="muted" style="margin-top:28px">Generated by X Account Fintwit performance checker · 12-month charts continue on following pages</div>
</div></body></html>`;
}

function buildChartHtml(svgPath, title, caption) {
  const svg = readFileSync(svgPath, "utf8");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  body { margin:0; font-family: Helvetica, Arial, sans-serif; background:#e5e7eb; }
  .page { width: 900px; margin: 24px auto; background:#fff; padding: 36px 40px;
          box-shadow: 0 10px 40px rgba(0,0,0,.12); }
  h1 { font-size: 18px; margin: 0 0 4px; color:#0f172a; }
  .sub { color:#64748b; font-size: 12px; margin-bottom: 16px; }
  .badge { display:inline-block; background:#0f172a; color:#fff; font-size:11px; padding:3px 9px; border-radius:6px; margin-bottom:12px; }
  .chart { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; background:#fafafa; overflow:hidden; }
  .legend { margin-top: 14px; font-size: 12px; color:#334155; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .L { background:#16a34a; } .S { background:#dc2626; } .N { background:#64748b; }
</style></head><body><div class="page">
  <div class="badge">Sample PDF report · price chart</div>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(caption)}</div>
  <div class="chart">${svg}</div>
  <div class="legend">
    <span class="dot L"></span> Long tweet &nbsp;&nbsp;
    <span class="dot S"></span> Short tweet &nbsp;&nbsp;
    <span class="dot N"></span> Neutral / unlabeled
    &nbsp;·&nbsp; dots mark tweet dates on the 12-month series
  </div>
</div></body></html>`;
}

function runChrome(htmlPath, pngPath, w, h) {
  const chrome =
    process.env.CHROME_PATH ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return new Promise((resolve, reject) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${w},${h}`,
      `--screenshot=${pngPath}`,
      pathToFileURL(htmlPath).href,
    ];
    const p = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || "chrome exit " + code));
    });
  });
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const sigma = loadReport("Infinite__Sigma_batch1of3");
  const chess = loadReport("chessNwine_batch1of3");

  const pages = [
    {
      html: buildSummaryHtml(sigma),
      file: "report-summary-crypto.png",
      w: 900,
      h: 1220,
    },
    {
      html: buildSummaryHtml(chess),
      file: "report-summary-equities.png",
      w: 900,
      h: 1220,
    },
    {
      html: buildChartHtml(
        join(
          root,
          "output/charts/Infinite__Sigma/2026-06-22_to_2026-07-22/ETH.svg"
        ),
        "$ETH · 12-month price with tweet markers",
        "@Infinite__Sigma · batch 2026-06-22 → 2026-07-22 · Yahoo ETH-USD"
      ),
      file: "report-chart-eth.png",
      w: 980,
      h: 580,
    },
    {
      html: buildChartHtml(
        join(root, "output/charts/chessNwine/2026-06-22_to_2026-07-22/QQQ.svg"),
        "$QQQ · 12-month price with tweet markers",
        "@chessNwine · batch 2026-06-22 → 2026-07-22 · Yahoo QQQ"
      ),
      file: "report-chart-qqq.png",
      w: 980,
      h: 580,
    },
    {
      html: buildChartHtml(
        join(
          root,
          "output/charts/Infinite__Sigma/2026-06-22_to_2026-07-22/PEPE.svg"
        ),
        "$PEPE · 12-month crypto chart with tweet markers",
        "@Infinite__Sigma · Yahoo PEPE crypto series"
      ),
      file: "report-chart-pepe.png",
      w: 980,
      h: 580,
    },
  ];

  for (const page of pages) {
    const htmlPath = join(tmpDir, page.file.replace(".png", ".html"));
    writeFileSync(htmlPath, page.html, "utf8");
    const pngPath = join(outDir, page.file);
    await runChrome(htmlPath, pngPath, page.w, page.h);
    console.log("wrote", page.file);
  }

  // cleanup blank test shots + tmp
  for (const junk of ["page1.png", "chessNwine-summary.png"]) {
    try {
      rmSync(join(outDir, junk), { force: true });
    } catch {}
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  console.log("Screenshots ready in docs/screenshots/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
