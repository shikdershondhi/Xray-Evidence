const { chromium } = require("@playwright/test");
const { XRAY_TEST_EXECUTIONS_URL } = require("./selectors");
const { saveJiraSession, waitForManualLogin } = require("./jira-session");

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: process.env.XRAY_BROWSER_CHANNEL || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  try {
    await page.goto(XRAY_TEST_EXECUTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    console.log("Complete Atlassian login and 2FA in the browser if prompted.");
    await waitForManualLogin(page, (_status, message) => console.log(message));
    await saveJiraSession(context);
    console.log("Saved Jira Xray auth state.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
