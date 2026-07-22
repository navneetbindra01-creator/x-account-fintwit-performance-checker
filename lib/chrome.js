/**
 * Shared Chrome launch + CDP connect (manual login profile).
 */
import { chromium } from "playwright";
import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import http from "http";
import net from "net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

export const PROFILE_DIR =
  process.env.PROFILE_DIR || join(ROOT, "chrome-manual-profile");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
].filter(Boolean);

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  throw new Error("Google Chrome not found. Set CHROME_PATH.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function waitForCdp(port, timeoutMs = 30000) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpGet(url);
      if (r.status === 200) return JSON.parse(r.body);
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error(`CDP not ready on port ${port}`);
}

function clearLocks(profileDir) {
  try {
    for (const name of readdirSync(profileDir)) {
      if (name.startsWith("Singleton") || name === "Lockfile") {
        try {
          unlinkSync(join(profileDir, name));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export async function hasAuthCookie(context) {
  try {
    const cookies = await context.cookies("https://x.com");
    return cookies.some(
      (c) =>
        (c.name === "auth_token" || c.name === "ct0") &&
        c.value &&
        c.value.length > 10
    );
  } catch {
    return false;
  }
}

/**
 * Launch Chrome, wait for login if needed, return { browser, context, page, port }.
 */
export async function launchChromeSession(options = {}) {
  const loginWaitMs = options.loginWaitMs ?? Number(process.env.LOGIN_WAIT_MS || 1200000);
  const chromePath = findChrome();
  mkdirSync(PROFILE_DIR, { recursive: true });
  clearLocks(PROFILE_DIR);

  const port = await getFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;

  console.log("Starting Chrome...");
  console.log("  Profile:", PROFILE_DIR);
  console.log("  CDP:    ", cdpUrl);

  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "https://x.com/home",
    ],
    { stdio: "ignore", windowsHide: false, detached: true }
  );
  chrome.unref();
  chrome.on("error", (err) => console.error("Chrome spawn error:", err.message));

  await waitForCdp(port);
  console.log("Chrome is up.");

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No browser context");

  let page =
    context.pages().find((p) => {
      const u = p.url();
      return u && !u.startsWith("devtools:");
    }) ||
    context.pages()[0] ||
    (await context.newPage());

  if (!(await hasAuthCookie(context))) {
    console.log("");
    console.log("======================================================");
    console.log("  Log into x.com in the Chrome window.");
    console.log("  Wait for email codes if needed — take your time.");
    console.log("  Script continues when session cookie is detected.");
    console.log("======================================================");
    console.log("");

    const deadline = Date.now() + loginWaitMs;
    let n = 0;
    while (Date.now() < deadline) {
      if (await hasAuthCookie(context)) {
        console.log("Login detected.");
        break;
      }
      n += 1;
      if (n % 15 === 0) {
        const mins = Math.round((deadline - Date.now()) / 60000);
        console.log(`Still waiting for login... (~${mins} min left)`);
      }
      await sleep(2000);
    }
    if (!(await hasAuthCookie(context))) {
      throw new Error("Timed out waiting for login.");
    }
  } else {
    console.log("Already logged in (saved session).");
  }

  return { browser, context, page, port, cdpUrl };
}
