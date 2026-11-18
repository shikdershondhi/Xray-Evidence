const fs = require("fs");
const path = require("path");
const { XRAY_SIDEBAR_NAMES } = require("./selectors");

const AUTH_DIR = path.resolve(__dirname, "../.xray-auth");
const JIRA_AUTH_STATE_PATH = path.join(AUTH_DIR, "jira-xray-auth-state.json");
const MANUAL_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
// Jira keeps its own URL for a couple of seconds after domcontentloaded and only then
// redirects to id.atlassian.com, so "signed in" must hold steady before it is trusted.
const AUTH_DETECT_TIMEOUT_MS = 20 * 1000;
const AUTH_STABLE_MS = 3000;
const LOGIN_POLL_MS = 1000;
const LOGIN_HEARTBEAT_MS = 30 * 1000;

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
  return /atlassian\.com\/login|id\.atlassian\.com|\/gateway\/login|atlassian\.net\/login(?:[/?#]|$)/i.test(
    url,
  );
}

function isJiraSiteUrl(url) {
  return /yaanainc\.atlassian\.net/i.test(url) && !isLoginUrl(url);
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error("Workflow cancelled."), {
      code: "XRAY_WORKFLOW_CANCELLED",
    });
  }
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

// The signed-in Jira shell exposes the sidebar Apps button (or the sidebar expander when
// it is collapsed) - the same controls the workflow itself needs next.
async function hasJiraShell(page) {
  for (const name of [XRAY_SIDEBAR_NAMES.apps, XRAY_SIDEBAR_NAMES.expandSidebar]) {
    const visible = await page
      .getByRole("button", { name })
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
    if (visible) return true;
  }
  return false;
}

// Resolves to "login" as soon as a login/2FA page is seen, "authenticated" once the Jira
// shell has stayed up for `stableMs` on a non-login URL, or "unknown" after `timeoutMs`.
async function waitForJiraAuthState(page, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || AUTH_DETECT_TIMEOUT_MS;
  const stableMs = options.stableMs === undefined ? AUTH_STABLE_MS : Number(options.stableMs);
  const deadline = Date.now() + timeoutMs;
  let shellSince = 0;

  while (Date.now() < deadline) {
    throwIfCancelled(options.signal);
    if (page.isClosed()) return "unknown";

    const url = page.url();
    if (isLoginUrl(url)) return "login";

    if (isJiraSiteUrl(url) && (await hasJiraShell(page))) {
      shellSince ||= Date.now();
      if (Date.now() - shellSince >= stableMs) return "authenticated";
    } else {
      shellSince = 0;
      if (await hasLoginChallenge(page)) return "login";
    }
    await sleep(250);
  }
  return "unknown";
}

// Waits (up to 5 minutes by default) for the person to finish Atlassian login + 2FA in the
// open browser window. The session is saved only after Jira is confirmed signed in, so a
// half-finished login can never overwrite a good saved session.
async function waitForManualLogin(page, notify, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || MANUAL_LOGIN_TIMEOUT_MS;
  const heartbeatMs = Number(options.heartbeatMs) || LOGIN_HEARTBEAT_MS;
  const pollMs = Number(options.pollMs) || LOGIN_POLL_MS;
  const save = options.save || saveJiraSession;
  const say = (status, message) =>
    notify(status, message, { level: "info", testcaseName: "", message });

  say(
    "waiting_for_login",
    `Complete Atlassian login and 2FA in the Playwright browser within ${formatDuration(timeoutMs)}. The workflow continues automatically once you are signed in.`,
  );

  const deadline = Date.now() + timeoutMs;
  let nextHeartbeat = Date.now() + heartbeatMs;

  while (Date.now() < deadline) {
    throwIfCancelled(options.signal);
    if (page.isClosed()) {
      throw new Error(
        "The Playwright browser window was closed before Jira login finished. Start the workflow again and keep the window open until login completes.",
      );
    }

    const state = await waitForJiraAuthState(page, {
      timeoutMs: Math.min(Math.max(deadline - Date.now(), 1), 10000),
      stableMs: options.stableMs,
      signal: options.signal,
    });
    if (state === "authenticated") {
      say("running", "Jira login detected. Saving session.");
      await save(page.context());
      return;
    }

    if (Date.now() >= nextHeartbeat) {
      const remaining = Math.max(deadline - Date.now(), 0);
      say(
        "waiting_for_login",
        `Still waiting for Jira login (${formatDuration(remaining)} left). Finish login/2FA in the Playwright browser window.`,
      );
      nextHeartbeat = Date.now() + heartbeatMs;
    }
    await sleep(pollMs);
  }

  throw new Error(
    `Jira login timed out after ${formatDuration(timeoutMs)}. Start the workflow again and complete Atlassian login/2FA in the Playwright browser.`,
  );
}

module.exports = {
  AUTH_DETECT_TIMEOUT_MS,
  authStatePath,
  hasLoginChallenge,
  hasSavedJiraSession,
  isLoginUrl,
  MANUAL_LOGIN_TIMEOUT_MS,
  saveJiraSession,
  waitForJiraAuthState,
  waitForManualLogin,
};
