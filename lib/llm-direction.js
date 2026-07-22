/**
 * Optional LLM direction classifier (default OFF).
 *
 * When enabled, tweets are sent in bulk to SpaceXAI / xAI (OpenAI-compatible API).
 * Returns Long | Short | Neutral per message.
 *
 * Env:
 *   XAI_API_KEY     required when --llm is on
 *   LLM_MODEL       default grok-4.5
 *   LLM_BATCH_SIZE  default 40
 *   XAI_BASE_URL    default https://api.x.ai/v1
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __llmDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__llmDir, "..");

/** Load KEY=VAL from project .env (optional, no dependency). */
export function loadProjectEnv() {
  const envPath = join(projectRoot, ".env");
  if (!existsSync(envPath)) return false;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
  return true;
}

// Auto-load .env when this module is imported
loadProjectEnv();

const DEFAULT_MODEL = process.env.LLM_MODEL || "grok-4.5";
const DEFAULT_BATCH = Number(process.env.LLM_BATCH_SIZE || 25);
const BASE_URL = (process.env.XAI_BASE_URL || "https://api.x.ai/v1").replace(
  /\/$/,
  ""
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build unique tweet rows for classification.
 * @param {Array} recommendations or tweet-like objects with statusId + text
 */
export function collectTweetsForLlm(items) {
  const byId = new Map();
  for (const r of items || []) {
    const id = r.statusId ? String(r.statusId) : null;
    if (!id) continue;
    if (byId.has(id)) continue;
    const text = (r.text || "").replace(/\s+/g, " ").trim();
    byId.set(id, {
      id,
      text: text || "(no text — chart or media only)",
      url: r.url || null,
      createdAt: r.createdAt || null,
    });
  }
  return [...byId.values()];
}

function buildPrompt(batch) {
  const lines = batch
    .map((t, i) => `${i + 1}. id=${t.id}\n   text: ${JSON.stringify(t.text)}`)
    .join("\n");

  return `You are classifying trading tweets for implied market stance.

For EACH message below, decide if the author is implying:
- Long — bullish / buying / wants price up / holding long / bid to buy
- Short — bearish / selling / trimming / exiting / wants price down
- Neutral — no clear trade direction, commentary only, ambiguous, or not about a trade

Rules:
- Use only the message text (and any symbols named in it).
- Do not invent tickers.
- If unsure, choose Neutral.
- Return ONLY valid JSON: an array of objects with keys "id" and "side".
- "side" must be exactly one of: "Long", "Short", "Neutral".
- Include every id exactly once.

Messages:
${lines}

JSON array:`;
}

function parseLlmJson(content) {
  if (!content) throw new Error("Empty LLM response");
  let s = content.trim();
  // strip markdown fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // find array
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const data = JSON.parse(s);
  if (!Array.isArray(data)) throw new Error("LLM JSON is not an array");
  return data;
}

function normalizeSide(side) {
  const s = String(side || "")
    .trim()
    .toLowerCase();
  if (s === "long" || s === "bull" || s === "bullish" || s === "buy")
    return "long";
  if (
    s === "short" ||
    s === "bear" ||
    s === "bearish" ||
    s === "sell" ||
    s === "exit"
  )
    return "short";
  return "neutral";
}

async function callChatCompletions(apiKey, model, prompt) {
  const maxTokens = Number(process.env.LLM_MAX_TOKENS || 8000);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content:
            "You classify trading tweet stance. Reply with JSON only, no prose.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = await res.json();
  const msg = json.choices?.[0]?.message || {};
  // Prefer final answer content; some models also fill reasoning_content
  let content =
    msg.content ||
    json.output_text ||
    json.choices?.[0]?.text ||
    null;
  if (typeof content === "string") content = content.trim();
  if (!content && typeof msg.reasoning_content === "string") {
    // last-resort: extract JSON array from reasoning if present
    const m = msg.reasoning_content.match(/\[[\s\S]*\]/);
    if (m) content = m[0];
  }
  if (!content) {
    const finish = json.choices?.[0]?.finish_reason;
    throw new Error(
      `Empty LLM response (finish=${finish}, keys=${Object.keys(msg).join(",")})`
    );
  }
  return content;
}

/**
 * Classify tweets in bulk.
 * @returns {Promise<{ byId: Map<string,'long'|'short'|'neutral'>, raw: Array, model: string }>}
 */
export async function classifyDirectionsWithLlm(tweets, options = {}) {
  const apiKey = options.apiKey || process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LLM direction requires XAI_API_KEY (SpaceXAI / xAI). Set the env var or turn --llm off."
    );
  }
  const model = options.model || DEFAULT_MODEL;
  const batchSize = options.batchSize || DEFAULT_BATCH;
  const list = tweets.length ? tweets : collectTweetsForLlm(options.items || []);

  console.log(
    `LLM direction: ${list.length} unique tweets, batch=${batchSize}, model=${model}`
  );

  const byId = new Map();
  const raw = [];

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(list.length / batchSize);
    console.log(`  LLM batch ${batchNum}/${totalBatches} (${batch.length} msgs)...`);

    let content;
    let attempt = 0;
    while (attempt < 3) {
      try {
        content = await callChatCompletions(
          apiKey,
          model,
          buildPrompt(batch)
        );
        break;
      } catch (e) {
        attempt += 1;
        console.warn(`  LLM batch failed (attempt ${attempt}): ${e.message}`);
        if (attempt >= 3) throw e;
        await sleep(1500 * attempt);
      }
    }

    let rows;
    try {
      rows = parseLlmJson(content);
    } catch (e) {
      console.warn("  LLM parse error, sample:", String(content).slice(0, 200));
      throw e;
    }

    for (const row of rows) {
      const id = String(row.id ?? row.statusId ?? "").trim();
      if (!id) continue;
      const side = normalizeSide(row.side ?? row.direction ?? row.label);
      byId.set(id, side);
      raw.push({ id, side, ...row });
    }

    // fill missing as neutral
    for (const t of batch) {
      if (!byId.has(t.id)) byId.set(t.id, "neutral");
    }

    if (i + batchSize < list.length) await sleep(300);
  }

  return { byId, raw, model };
}

/**
 * Apply LLM sides onto recommendations / analyzed tweets.
 * When LLM is off, forces neutral (no Long/Short).
 */
export function applyDirectionLabels(recommendations, llmResult, options = {}) {
  const llmOn = !!options.llmOn;
  const byId = llmResult?.byId || new Map();

  return (recommendations || []).map((r) => {
    if (!llmOn) {
      return {
        ...r,
        direction: "mention",
        directionObvious: false,
        directionReason: "llm_off",
        llmSide: null,
      };
    }
    const id = r.statusId ? String(r.statusId) : null;
    const side = id && byId.has(id) ? byId.get(id) : "neutral";
    if (side === "long" || side === "short") {
      return {
        ...r,
        direction: side,
        directionObvious: true,
        directionReason: "llm",
        llmSide: side,
      };
    }
    return {
      ...r,
      direction: "mention",
      directionObvious: false,
      directionReason: "llm_neutral",
      llmSide: "neutral",
    };
  });
}

/**
 * Apply to analyzed tweet objects (for JSON consistency).
 */
export function applyDirectionToAnalyzed(analyzed, llmResult, options = {}) {
  const llmOn = !!options.llmOn;
  const byId = llmResult?.byId || new Map();
  return (analyzed || []).map((t) => {
    if (!llmOn) {
      return {
        ...t,
        direction: "neutral",
        directionObvious: false,
        directionReason: "llm_off",
        llmSide: null,
      };
    }
    const id = t.statusId ? String(t.statusId) : null;
    const side = id && byId.has(id) ? byId.get(id) : "neutral";
    return {
      ...t,
      direction: side === "long" || side === "short" ? side : "neutral",
      directionObvious: side === "long" || side === "short",
      directionReason: side === "long" || side === "short" ? "llm" : "llm_neutral",
      llmSide: side,
    };
  });
}

/** Pretty table for console */
export function formatLlmTable(byId) {
  const rows = [...byId.entries()].map(([id, side]) => ({ id, side }));
  const counts = { long: 0, short: 0, neutral: 0 };
  for (const r of rows) counts[r.side] = (counts[r.side] || 0) + 1;
  return { rows, counts };
}
