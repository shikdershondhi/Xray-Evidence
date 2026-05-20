const fs = require("fs");
const path = require("path");

const AUTH_DIR = path.resolve(__dirname, "../.xray-auth");
const JIRA_AUTH_STATE_PATH = path.join(AUTH_DIR, "jira-xray-auth-state.json");
const MANUAL_LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

function authStatePath() {
  return JIRA_AUTH_STATE_PATH;
}

function hasSavedJiraSession() {
  return fs.existsSync(JIRA_AUTH_STATE_PATH);
}

function ensureAuthDir() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function saveJiraSession(context) {
  ensureAuthDir();
  await context.storageState({ path: JIRA_AUTH_STATE_PATH });
}

function isLoginUrl(url) {
  return /atlassian\.com\/login|id\.atlassian\.com|\/gateway\/login/i.test(url);
}

async function hasLoginChallenge(page) {
  if (isLoginUrl(page.url())) return true;

  const loginSelectors = [
    'input[type="email"]',
    'input[name="username"]',
    'input[id*="username" i]',
    'input[type="password"]',
    'button:has-text("Log in")',
    'button:has-text("Continue")',
    'text=/two-step|2fa|verification code|authenticator/i',
  ];

  const scopes = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  for (const scope of scopes) {
    for (const selector of loginSelectors) {
      if (await scope.locator(selector).first().isVisible({ timeout: 300 }).catch(() => false)) {
        return true;
      }
    }
  }

  return false;
}

async function waitForManualLogin(page, notify) {
  notify(
    "waiting_for_login",
    "Complete Atlassian login and 2FA in the Playwright browser within 3 minutes.",
  );
  try {
    await page.waitForFunction(
      () => {
        const href = window.location.href;
        return (
          href.includes("yaanainc.atlassian.net") &&
          !/atlassian\.com\/login|id\.atlassian\.com|\/gateway\/login/i.test(href)
        );
      },
      null,
      { timeout: MANUAL_LOGIN_TIMEOUT_MS },
    );
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new Error(
        "Jira login timed out after 3 minutes. Start the workflow again and complete Atlassian login/2FA in the Playwright browser.",
      );
    }
    throw error;
  }
  notify("running", "Jira login detected. Saving session.");
  await saveJiraSession(page.context());
}

module.exports = {
  authStatePath,
  hasLoginChallenge,
  hasSavedJiraSession,
  isLoginUrl,
  MANUAL_LOGIN_TIMEOUT_MS,
  saveJiraSession,
  waitForManualLogin,
};
