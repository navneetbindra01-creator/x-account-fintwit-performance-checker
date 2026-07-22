import { chromium } from "playwright";

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP_URL);
const context = browser.contexts()[0];
const page =
  context.pages().find((p) => !p.url().startsWith("devtools:")) ||
  (await context.newPage());

console.log("Current URL:", page.url());
await page.goto("https://x.com/home", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 3500));
console.log("After navigate:", page.url());
console.log("Title:", await page.title());

const loginVisible = await page
  .locator('a[href="/login"], [data-testid="loginButton"]')
  .first()
  .isVisible()
  .catch(() => false);

const sideNav = await page
  .locator(
    '[data-testid="AppTabBar_Home_Link"], [data-testid="SideNav_AccountSwitcher_Button"]'
  )
  .first()
  .isVisible()
  .catch(() => false);

const compose = await page
  .locator(
    '[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]'
  )
  .first()
  .isVisible()
  .catch(() => false);

const status =
  sideNav || compose
    ? "LOGGED_IN"
    : loginVisible
      ? "LOGGED_OUT"
      : "UNKNOWN";

console.log(JSON.stringify({ status, loginVisible, sideNav, compose }, null, 2));

// Disconnect only — leave Edge open
await browser.close().catch(() => {});
process.exit(status === "LOGGED_IN" ? 0 : 2);
