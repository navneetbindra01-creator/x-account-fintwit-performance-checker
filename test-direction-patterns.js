import { extractDirectionDetailed } from "./lib/extract.js";

const cases = [
  ["short", "trimming $MSFT into strength"],
  ["short", "trimmed the position"],
  ["short", "trim some size"],
  ["short", "took profit on NVDA"],
  ["short", "took profits here"],
  ["short", "sell $PDD into the open"],
  ["short", "unloading bags on the breakout"],
  ["long", "opened a long in $MU"],
  ["long", "opening $IGV here"],
  ["long", "openened size overnight on the chart"],
  ["long", "loading $NVO"],
  ["long", "loading up more shares"],
  ["neutral", "opening range breakout on ES"],
  ["neutral", "market sell-off continues"],
];

let fail = 0;
for (const [want, t] of cases) {
  const d = extractDirectionDetailed(t);
  const ok = d.direction === want;
  if (!ok) fail++;
  console.log(
    (ok ? "OK " : "FAIL") +
      ` want=${want.padEnd(7)} got=${d.direction.padEnd(7)} | ${t}`
  );
}
process.exit(fail ? 1 : 0);
