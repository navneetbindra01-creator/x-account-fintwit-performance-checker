import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (!existsSync(envPath)) {
  console.log("NO_ENV_FILE");
  process.exit(1);
}
const text = readFileSync(envPath, "utf8");
console.log("fileBytes", Buffer.byteLength(text));
console.log("hasBOM", text.charCodeAt(0) === 0xfeff);
for (const line of text.split(/\r?\n/)) {
  const s = line.trim();
  if (!s || s.startsWith("#")) continue;
  const eq = s.indexOf("=");
  if (eq < 0) continue;
  const key = s.slice(0, eq).trim();
  let val = s.slice(eq + 1).trim();
  const hadQuotes =
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"));
  if (hadQuotes) val = val.slice(1, -1);
  console.log(
    JSON.stringify({
      key,
      valLen: val.length,
      startsWithXai: val.startsWith("xai-"),
      hasWhitespace: /\s/.test(val),
      hadQuotes,
      first4: val.slice(0, 4),
    })
  );
}
