const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const {
  ACTUAL_RESULT_TARGETS,
  PLAY_BUTTON_FALLBACK_SELECTOR,
  SAVE_TARGETS,
  JIRA_PROJECT_URL,
  SEARCH_INPUT_SELECTORS,
  TEST_EXECUTION_LINK_FALLBACK_SELECTOR,
  XRAY_BOARD_PATH_PATTERN,
  XRAY_FRAME_URL_PATTERN,
  XRAY_SIDEBAR_NAMES,
} = require("./selectors");
const {
  authStatePath,
  hasLoginChallenge,
  hasSavedJiraSession,
  saveJiraSession,
  waitForJiraAuthState,
  waitForManualLogin,
} = require("./jira-session");

const DEBUG_LOG_PATH = path.resolve(__dirname, "workflow-debug.log");

let sharedBrowser = null;
let sharedBrowserContext = null;
let sharedBrowserMode = null;

async function closeSharedBrowser() {
  const browser = sharedBrowser;
  sharedBrowser = null;
  sharedBrowserContext = null;
  sharedBrowserMode = null;
  if (browser) await browser.close().catch(() => {});
}

async function isSharedBrowserResponsive() {
  if (!sharedBrowser || !sharedBrowser.isConnected() || !sharedBrowserContext) return false;
  try {
    const probePage =
      sharedBrowserContext.pages().find((p) => !p.isClosed()) ||
      (await sharedBrowserContext.newPage());
    await Promise.race([
      probePage.evaluate(() => true),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("shared browser responsiveness probe timed out")), 4000)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function getSharedBrowserContext(browserMode) {
  if (sharedBrowserMode === browserMode && (await isSharedBrowserResponsive())) {
    return { browser: sharedBrowser, context: sharedBrowserContext };
  }
  await closeSharedBrowser();

  sharedBrowser = await chromium.launch(buildChromiumLaunchOptions(browserMode));
  sharedBrowserMode = browserMode;
  sharedBrowser.on("disconnected", () => {
    if (sharedBrowser && !sharedBrowser.isConnected()) {
      sharedBrowser = null;
      sharedBrowserContext = null;
      sharedBrowserMode = null;
    }
  });

  const contextOptions = hasSavedJiraSession()
    ? { storageState: authStatePath() }
    : {};
  sharedBrowserContext = await sharedBrowser.newContext({
    ...contextOptions,
    viewport: { width: 1920, height: 1080 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  return { browser: sharedBrowser, context: sharedBrowserContext };
}

async function getSharedPage(browserMode) {
  const { context } = await getSharedBrowserContext(browserMode);
  await Promise.all(
    context
      .pages()
      .filter((p) => !p.isClosed())
      .map((p) => p.close().catch(() => {}))
  );
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
  return page;
}

function logDebug(message, data = undefined) {
  const line = {
    at: new Date().toISOString(),
    message,
    ...(data === undefined ? {} : { data }),
  };
  fs.appendFileSync(DEBUG_LOG_PATH, `${JSON.stringify(line)}\n`);
}

function normalizeForMatch(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function wordTokensForMatch(value) {
  return normalizeForMatch(value)
    .replace(/[“”‘’"']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokensEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}

function tokensContainExactSequence(candidate, expected) {
  if (!candidate.length || !expected.length || candidate.length < expected.length) {
    return false;
  }
  for (let start = 0; start <= candidate.length - expected.length; start += 1) {
    if (tokensEqual(candidate.slice(start, start + expected.length), expected)) {
      return true;
    }
  }
  return false;
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error("Evidence must be a PNG data URL.");
  return Buffer.from(match[1], "base64");
}

// Local statuses that are never uploaded to Xray; value is the display label.
const SKIPPED_LOCAL_STATUS_LABELS = {
  blocked: "Blocked",
  na: "N/A",
  notrun: "Not Run",
};

function normalizeWorkflowStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "fail") return "fail";
  if (Object.hasOwn(SKIPPED_LOCAL_STATUS_LABELS, normalized)) return normalized;
  return "pass";
}

// Returns the display label when a local status must not be uploaded, else "".
function localSkipLabel(status, passOnly) {
  if (Object.hasOwn(SKIPPED_LOCAL_STATUS_LABELS, status)) {
    return SKIPPED_LOCAL_STATUS_LABELS[status];
  }
  if (passOnly === true && status === "fail") return "Fail (Pass-only upload is on)";
  return "";
}

function normalizeBrowserMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "headed" ? "headed" : "headless";
}

function buildChromiumLaunchOptions(browserMode) {
  return {
    headless: normalizeBrowserMode(browserMode) === "headless",
    channel: process.env.XRAY_BROWSER_CHANNEL || undefined,
  };
}

function workflowCancelledError() {
  return Object.assign(new Error("Workflow cancelled."), {
    code: "XRAY_WORKFLOW_CANCELLED",
  });
}

function throwIfWorkflowCancelled(signal) {
  if (signal?.aborted) {
    throw workflowCancelledError();
  }
}

function notifyLog(notify, level, testcaseName, message, status = "running") {
  notify(status, message, { level, testcaseName, message });
}

// Headless Chromium has no window to type a password or 2FA code into, so login runs in
// a temporary visible browser. waitForManualLogin saves the session once Jira confirms
// the sign-in; the caller then restarts the headless browser with that saved session.
async function loginInVisibleBrowser(notify, options = {}) {
  const browser = await chromium.launch(buildChromiumLaunchOptions("headed"));
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();
    await page.goto(JIRA_PROJECT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await waitForManualLogin(page, notify, { signal: options.signal });
  } finally {
    await browser.close().catch(() => {});
  }
}

// Opens Jira and returns a page that is confirmed signed in. A saved session is only
// refreshed once Jira has shown its signed-in shell for a few seconds: Jira redirects to
// the login page a moment after domcontentloaded, and saving before then used to overwrite
// a good session with an unauthenticated one.
async function openJiraSignedIn(page, browserMode, notify, options = {}) {
  const deps = {
    closeSharedBrowser,
    getSharedPage,
    loginInVisibleBrowser,
    saveJiraSession,
    ...options.deps,
  };
  const { signal, authOptions } = options;
  const openJira = (target) =>
    target.goto(JIRA_PROJECT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  await openJira(page);
  let state = await waitForJiraAuthState(page, { ...authOptions, signal });
  if (state === "authenticated") {
    await deps.saveJiraSession(page.context());
    return page;
  }
  if (state === "unknown") {
    throw new Error(
      `Could not confirm that Jira is signed in (the page stayed on ${page.url()}). Check the network/VPN and start the workflow again.`,
    );
  }

  let activePage = page;
  if (normalizeBrowserMode(browserMode) === "headless") {
    notifyLog(
      notify,
      "warn",
      "",
      "Jira login is required. Opening a visible browser window for login; the run continues in headless mode afterwards.",
      "waiting_for_login",
    );
    await deps.loginInVisibleBrowser(notify, { signal });
    await deps.closeSharedBrowser();
    activePage = await deps.getSharedPage(browserMode);
  } else {
    await waitForManualLogin(page, notify, { signal, save: deps.saveJiraSession });
  }

  notifyLog(notify, "info", "", "Login complete. Reopening Jira with the saved session.");
  await openJira(activePage);
  state = await waitForJiraAuthState(activePage, { ...authOptions, signal });
  if (state !== "authenticated") {
    throw new Error(
      `Jira login finished but Jira did not open signed in (current page ${activePage.url()}). Start the workflow again.`,
    );
  }
  return activePage;
}

function getXrayRowExecutionStatusFromText(text) {
  const normalized = normalizeForMatch(text);
  if (/\bpassed\b/.test(normalized)) return "passed";
  if (/\bfailed\b/.test(normalized)) return "failed";
  if (/\bto\s+do\b/.test(normalized)) return "todo";
  return "unknown";
}

async function getXrayRowExecutionStatus(row) {
  return getXrayRowExecutionStatusFromText(
    await row.innerText({ timeout: 1200 }).catch(() => ""),
  );
}

function shouldSkipExecutedRow(rowStatus) {
  return rowStatus === "passed" || rowStatus === "failed";
}

async function runXrayWorkflow(payload, notify = () => {}, options = {}) {
  throwIfWorkflowCancelled(options.signal);
  const browserMode = normalizeBrowserMode(payload.browserMode);
  logDebug("workflow started", {
    summary: payload.testExecutionSummary,
    mode: payload.mode,
    browserMode,
    items: payload.items.map((item) => ({
      testcaseName: item.testcaseName,
      status: normalizeWorkflowStatus(item.status),
    })),
  });
  notifyLog(notify, "info", "", `Reusing shared Playwright session in ${browserMode} mode.`);
  let page = await getSharedPage(browserMode);
  const results = [];
  const runOptions = { signal: options.signal, browserMode };

  throwIfWorkflowCancelled(options.signal);
  notifyLog(notify, "info", "", "Opening Jira.");
  page = await openJiraSignedIn(page, browserMode, notify, { signal: options.signal });

  notifyLog(notify, "info", "", "Opening Xray Testing Board from the sidebar (Apps > Xray > Testing Board).");
  await openXrayTestingBoard(page);
  await prepareXrayTestExecutionsList(page, notify, runOptions);
  // Remember the executions-list URL the sidebar led to so later testcases can return
  // here without redoing the sidebar walk. It is discovered at run time, never hardcoded.
  const xrayBoardUrl = page.url();
  throwIfWorkflowCancelled(options.signal);
  notifyLog(notify, "info", "", `Searching execution "${payload.testExecutionSummary}".`);
  await openTestExecution(page, payload.testExecutionSummary);

  for (const [index, item] of payload.items.entries()) {
    throwIfWorkflowCancelled(options.signal);
    const itemStatus = normalizeWorkflowStatus(item.status);
    const skipLabel = localSkipLabel(itemStatus, payload.passOnly);
    if (skipLabel) {
      const message = `Skipped because local status is ${skipLabel}.`;
      notifyLog(notify, "warn", item.testcaseName, message);
      const skippedResult = {
        testcaseName: item.testcaseName,
        status: "skipped",
        localStatus: itemStatus,
        message,
      };
      results.push(skippedResult);
      options.onResult?.(skippedResult);
      continue;
    }
    let currentStep = "Starting testcase";
    try {
      if (index > 0) {
        currentStep = "Returning to Jira Xray test executions";
        notifyLog(notify, "info", item.testcaseName, "Returning to Jira Xray test executions.");
        await returnToXrayTestExecutions(page, xrayBoardUrl, notify, runOptions);
        await openTestExecution(page, payload.testExecutionSummary);
      }
      const localStatus = normalizeWorkflowStatus(item.status);
      currentStep = "Opening testcase row";
      notifyLog(notify, "info", item.testcaseName, "Opening testcase row.");
      logDebug("processing testcase workflow item", {
        testcaseName: item.testcaseName,
        localStatus,
      });
      const openResult = await openTestcaseExecution(page, item.testcaseName, notify);
      if (openResult.status === "skipped") {
        notifyLog(
          notify,
          "warn",
          item.testcaseName,
          `Skipped because Xray row is already ${openResult.rowStatus}.`,
        );
        const skippedResult = {
          testcaseName: item.testcaseName,
          status: "skipped",
          localStatus,
          rowStatus: openResult.rowStatus,
          message: `Skipped because Xray row is already ${openResult.rowStatus}.`,
        };
        results.push(skippedResult);
        options.onResult?.(skippedResult);
        continue;
      }
      currentStep = "Starting timer";
      notifyLog(notify, "info", item.testcaseName, "Starting timer if needed.");
      let xray = await resolveXrayScope(page);
      await clickTimerStartIfStopped(xray);
      notifyLog(notify, "info", item.testcaseName, "Timer step completed.");
      currentStep = "Pasting Actual Result evidence";
      await pasteActualResultEvidence(page, item.evidencePngDataUrl, notify, item.testcaseName);
      currentStep = "Updating execution status";
      notifyLog(notify, "info", item.testcaseName, `Updating Xray status to ${localStatus}.`);
      xray = await resolveXrayScope(page);
      await requireExecutionStatus(xray, localStatus);
      notifyLog(notify, "info", item.testcaseName, `Xray status updated to ${localStatus}.`);
      notifyLog(notify, "info", item.testcaseName, "Evidence upload completed.");
      const successResult = {
        testcaseName: item.testcaseName,
        status: "success",
        localStatus,
        message: "Evidence uploaded.",
      };
      results.push(successResult);
      options.onResult?.(successResult);
    } catch (error) {
      throwIfWorkflowCancelled(options.signal);
      const message = `${currentStep} failed: ${error.message}`;
      notifyLog(notify, "error", item.testcaseName, message);
      const failedResult = {
        testcaseName: item.testcaseName,
        status: "failed",
        localStatus: normalizeWorkflowStatus(item.status),
        message,
      };
      results.push(failedResult);
      options.onResult?.(failedResult);
    }
  }

  const failed = results.filter((item) => item.status === "failed");
  const skipped = results.filter((item) => item.status === "skipped");
  return {
    status: failed.length ? "partial" : "success",
    message: failed.length
      ? `${failed.length} testcase upload failed.`
      : skipped.length
        ? `Workflow completed; ${skipped.length} testcase(s) skipped.`
        : "All evidence uploaded to Xray.",
    results,
  };
}

async function expandSidebarSection(button, label, timeoutMs) {
  await button.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {
    throw new Error(
      `Jira sidebar item "${label}" was not found. Make sure the Jira sidebar is visible and the Xray app is installed for this site.`,
    );
  });
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.click();
  }
}

// Reaches the Xray Testing Board the way a person does: Jira sidebar > Apps > Xray >
// Testing Board. Nothing about the Xray app route (app/environment UUIDs) is hardcoded,
// so Xray reinstalls or migrations do not break navigation.
async function openXrayTestingBoard(page, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);

  const appsButton = page.getByRole("button", { name: XRAY_SIDEBAR_NAMES.apps }).first();
  if (!(await appsButton.isVisible({ timeout: 5000 }).catch(() => false))) {
    const expandSidebar = page
      .getByRole("button", { name: XRAY_SIDEBAR_NAMES.expandSidebar })
      .first();
    if (await expandSidebar.isVisible({ timeout: 1000 }).catch(() => false)) {
      await expandSidebar.click();
    }
  }
  await expandSidebarSection(appsButton, "Apps", timeoutMs);

  const xrayButton = page.getByRole("button", { name: XRAY_SIDEBAR_NAMES.xray }).first();
  await expandSidebarSection(xrayButton, "Xray", timeoutMs);

  const testingBoardLink = page
    .getByRole("link", { name: XRAY_SIDEBAR_NAMES.testingBoard })
    .first();
  await testingBoardLink.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {
    throw new Error(
      'Jira sidebar item "Testing Board" was not found under Apps > Xray. The Xray sidebar layout may have changed.',
    );
  });
  await testingBoardLink.click();
  await page
    .waitForURL((url) => XRAY_BOARD_PATH_PATTERN.test(url.pathname), {
      timeout: timeoutMs,
      waitUntil: "commit",
    })
    .catch(() => {
      throw new Error(
        `Clicking Testing Board in the Jira sidebar did not open the Xray board. Current URL: ${page.url()}`,
      );
    });
  logDebug("opened Xray testing board from sidebar", { pageUrl: page.url() });
  return page.url();
}

// Goes back to the Xray test-executions list after a testcase. Fast path reloads the
// board URL the sidebar produced at the start of the run; if that does not load, it
// falls back to walking the sidebar again.
async function returnToXrayTestExecutions(page, boardUrl, notify, options = {}) {
  try {
    await page.goto(boardUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    // The board URL differs from the testcase-detail URL only by its hash, so the goto
    // above is a same-document fragment navigation that never re-triggers the app's
    // board data fetch. Force a real reload so the app reinitializes on the list route.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
    await prepareXrayTestExecutionsList(page, notify, { ...options, timeoutMs: 45000 });
  } catch (error) {
    if (error?.code === "XRAY_WORKFLOW_CANCELLED") throw error;
    logDebug("returning via saved board URL failed; using sidebar", {
      boardUrl,
      error: error.message,
    });
    await page.goto(JIRA_PROJECT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await openXrayTestingBoard(page);
    await prepareXrayTestExecutionsList(page, notify, options);
  }
}

function isTestExecutionsListUrl(url) {
  return /(?:[#!?&]|^)page=test-executions(?:[&]|$)/i.test(String(url || ""));
}

// Xray reopens the last page you viewed, so the sidebar's Testing Board link can land on
// a previous execution instead of the executions list. When that happens, go back with
// the app's own "Test Executions" breadcrumb rather than assuming a hardcoded route.
async function ensureXrayTestExecutionsList(page, options = {}) {
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 15000);

  // Let the app settle on a route; its hash is written shortly after the page loads.
  const settleDeadline = Date.now() + Math.min(timeoutMs, 8000);
  while (!/page=/i.test(page.url()) && Date.now() < settleDeadline) {
    await page.waitForTimeout(250);
  }
  // Xray restores whatever page was last open: an execution board, or the testcase details
  // page (#page=test-run) that a previous run ended on. Only the list has the search table.
  if (!/page=/i.test(page.url()) || isTestExecutionsListUrl(page.url())) return;

  logDebug("Xray reopened a page other than the executions list; returning to the list", {
    pageUrl: page.url(),
  });
  // Live Xray (Forge) leaves its frame empty for several seconds and shows the breadcrumb
  // ~16s after the board opens, and the content frame can change while it loads. Poll,
  // re-resolving the frame each time, instead of checking once (isVisible ignores timeouts).
  const breadcrumbTimeoutMs = Math.max(500, Number(options.breadcrumbTimeoutMs) || 45000);
  const breadcrumbDeadline = Date.now() + breadcrumbTimeoutMs;
  let breadcrumb = null;
  while (Date.now() < breadcrumbDeadline) {
    const xray = await resolveXrayScope(page);
    const candidate = xray.getByRole("link", { name: /^Test Executions$/ }).first();
    if (await candidate.isVisible().catch(() => false)) {
      breadcrumb = candidate;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!breadcrumb) {
    throw new Error(
      `Xray opened an execution board and the Test Executions breadcrumb was not found to return to the list after ${Math.round(breadcrumbTimeoutMs / 1000)}s. Current URL: ${page.url()}`,
    );
  }
  await breadcrumb.click();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isTestExecutionsListUrl(page.url())) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Clicking the Test Executions breadcrumb did not show the executions list. Current URL: ${page.url()}`,
  );
}

// Leave any restored non-list page first (the board and testcase details pages are not the
// list and the details page has nothing for "app ready" to wait on), then wait for the list.
async function prepareXrayTestExecutionsList(page, notify, options = {}) {
  await ensureXrayTestExecutionsList(page);
  await waitForXrayAppReady(page, notify, options);
}

async function openTestExecution(page, summary, options = {}) {
  await page.waitForLoadState("domcontentloaded");
  const xray = await resolveXrayScope(page);
  const transitionTimeoutMs = Math.max(
    100,
    Number(options.transitionTimeoutMs) || 8000,
  );
  logDebug("opening test execution", {
    summary,
    pageUrl: page.url(),
    scopeUrl: typeof xray.url === "function" ? xray.url() : page.url(),
  });
  await searchVisibleTable(xray, summary);
  const row = await findUniqueRowByText(xray, summary, "test execution summary");
  logDebug("matched test execution row", {
    summary,
    rowText: await row.innerText().catch(() => ""),
    actions: await collectActionableElements(row),
  });

  const tryTransition = async (strategy, click) => {
    const beforeUrl = page.url();
    logDebug("trying test execution open strategy", { summary, strategy, beforeUrl });
    await click();
    const opened = await waitForTestExecutionBoard(page, transitionTimeoutMs);
    logDebug("test execution open strategy result", {
      summary,
      strategy,
      opened,
      beforeUrl,
      afterUrl: page.url(),
    });
    return opened;
  };

  if (await tryTransition("select-row", () => row.click())) return;

  const rowLink = row.locator("a").filter({ hasText: summary }).first();
  if (
    (await rowLink.isVisible({ timeout: 1000 }).catch(() => false)) &&
    (await tryTransition("summary-link", () => rowLink.click()))
  ) {
    return;
  }

  const executionIssueLink = row
    .locator('a[href*="ac.testExecutionId="], a[href*="testExecutionId="]')
    .first();
  if (
    (await executionIssueLink.isVisible({ timeout: 1000 }).catch(() => false)) &&
    (await tryTransition("execution-issue-link", () => executionIssueLink.click()))
  ) {
    return;
  }

  const explicitRowAction = row
    .locator(
      'button[aria-label*="open" i], button[title*="open" i], [role="button"][aria-label*="open" i], [role="button"][title*="open" i]',
    )
    .first();
  if (
    (await explicitRowAction.isVisible({ timeout: 1000 }).catch(() => false)) &&
    (await tryTransition("row-open-action", () => explicitRowAction.click()))
  ) {
    return;
  }

  const selectedExecutionLink = xray.locator(TEST_EXECUTION_LINK_FALLBACK_SELECTOR).first();
  if (
    (await selectedExecutionLink.isVisible({ timeout: 1000 }).catch(() => false)) &&
    (await tryTransition("selected-execution-link", () => selectedExecutionLink.click()))
  ) {
    return;
  }

  await row.click({ button: "right" });
  const openMenuItem = xray.getByRole("menuitem", { name: /^open$/i });
  if (
    (await openMenuItem.isVisible({ timeout: 1000 }).catch(() => false)) &&
    (await tryTransition("context-menu-open", () => openMenuItem.click()))
  ) {
    return;
  }

  if (await tryTransition("double-click-row", () => row.dblclick())) {
    return;
  }

  throw new Error(
    `Test execution "${summary}" did not open its testcase board. Current URL: ${page.url()}`,
  );
}

function isTestExecutionBoardUrl(url) {
  const value = String(url || "");
  return (
    /(?:[#!?&]|^)page=test-execution-board(?:[&]|$)/i.test(value) &&
    /(?:[?&#]|^)(?:testExecutionId|testExecutionKey)=[^&#]+/i.test(value)
  );
}

async function waitForTestExecutionBoard(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isTestExecutionBoardUrl(page.url())) return true;
    await page.waitForTimeout(100);
  }
  return isTestExecutionBoardUrl(page.url());
}

async function openTestcaseExecution(page, testcaseName, notify = () => {}) {
  const xray = await resolveXrayScope(page);
  logDebug("opening testcase execution", {
    testcaseName,
    pageUrl: page.url(),
    scopeUrl: typeof xray.url === "function" ? xray.url() : page.url(),
  });
  notifyLog(notify, "info", testcaseName, "Searching testcase row.");
  await searchVisibleTable(xray, testcaseName);
  const row = await findUniqueRowByText(xray, testcaseName, "testcase name");
  await row.click();
  const rowStatus = await getXrayRowExecutionStatus(row);
  const skip = shouldSkipExecutedRow(rowStatus);
  notifyLog(
    notify,
    "info",
    testcaseName,
    `Matched testcase row with Xray status ${rowStatus}.`,
  );
  logDebug("matched testcase row clicked", {
    testcaseName,
    rowText: await row.innerText().catch(() => ""),
    rowStatus,
    skip,
    actions: await collectActionableElements(row),
  });
  logDebug("testcase row execution status decision", {
    testcaseName,
    rowStatus,
    skip,
  });

  if (skip) {
    notifyLog(notify, "warn", testcaseName, `Skip decision: row is already ${rowStatus}.`);
    return { status: "skipped", rowStatus };
  }
  notifyLog(notify, "info", testcaseName, "Opening testcase execution details.");

  if (process.env.XRAY_DRY_RUN_AFTER_TESTCASE_ROW === "1") {
    throw new Error("Dry run stopped after matching and selecting testcase row.");
  }

  if (await clickFarRightRowAction(page, row, testcaseName)) {
    await waitForTestcaseExecutionDetails(page, testcaseName, notify);
    await afterTestcaseOpenDryRun();
    return { status: "opened", rowStatus };
  }

  const scopedPlay = row
    .locator('button[aria-label*="play" i], button[title*="play" i], [role="button"][aria-label*="play" i]')
    .first();
  if (await scopedPlay.isVisible({ timeout: 3000 }).catch(() => false)) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      scopedPlay.click(),
    ]);
    await waitForTestcaseExecutionDetails(page, testcaseName, notify);
    await afterTestcaseOpenDryRun();
    return { status: "opened", rowStatus };
  }

  const fallback = xray.locator(PLAY_BUTTON_FALLBACK_SELECTOR).first();
  if (await fallback.isVisible({ timeout: 3000 }).catch(() => false)) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      fallback.click(),
    ]);
    await waitForTestcaseExecutionDetails(page, testcaseName, notify);
    await afterTestcaseOpenDryRun();
    return { status: "opened", rowStatus };
  }

  const genericPlay = xray
    .locator('button[aria-label*="play" i], button[title*="play" i]')
    .first();
  if (await genericPlay.isVisible({ timeout: 3000 }).catch(() => false)) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      genericPlay.click(),
    ]);
    await waitForTestcaseExecutionDetails(page, testcaseName, notify);
    await afterTestcaseOpenDryRun();
    return { status: "opened", rowStatus };
  }

  const rowActionButtons = row.locator("button");
  const buttonCount = await rowActionButtons.count();
  for (let index = buttonCount - 1; index >= 0; index -= 1) {
    const button = rowActionButtons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    logDebug("clicking unlabeled testcase row action button", {
      testcaseName,
      buttonIndex: index,
      buttonText: await button.innerText().catch(() => ""),
    });
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      button.click(),
    ]);
    await page.waitForTimeout(1500);
    await waitForTestcaseExecutionDetails(page, testcaseName, notify);
    await afterTestcaseOpenDryRun();
    return { status: "opened", rowStatus };
  }

  throw new Error(`Could not find testcase action button for "${testcaseName}".`);
}

async function afterTestcaseOpenDryRun() {
  if (process.env.XRAY_DRY_RUN_AFTER_TESTCASE_OPEN === "1") {
    throw new Error("Dry run stopped after opening testcase execution details.");
  }
}

async function collectVisibleRowActions(row) {
  const buttons = row.locator("button, [role='button']");
  const buttonCount = await buttons.count();
  const visible = [];

  for (let index = 0; index < buttonCount; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box) continue;
    visible.push({
      index,
      button,
      x: box.x,
      text: await button.innerText().catch(() => ""),
      ariaLabel: await button.getAttribute("aria-label").catch(() => ""),
      title: await button.getAttribute("title").catch(() => ""),
    });
  }
  return visible;
}

// Row actions render a moment after the row is selected; do not conclude "no actions"
// from a single snapshot taken right after the click.
async function clickFarRightRowAction(page, row, testcaseName, options = {}) {
  const waitMs = Number(options.actionWaitMs ?? 8000);
  const deadline = Date.now() + waitMs;
  let visible = await collectVisibleRowActions(row);
  while (!visible.length && Date.now() < deadline) {
    await page.waitForTimeout(400);
    visible = await collectVisibleRowActions(row);
  }

  if (!visible.length) return false;
  visible.sort((left, right) => right.x - left.x);
  const target = visible[0];
  logDebug("clicking far-right testcase row action", {
    testcaseName,
    buttonIndex: target.index,
    x: target.x,
    text: target.text,
    ariaLabel: target.ariaLabel,
    title: target.title,
  });

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    target.button.click(),
  ]);
  await page.waitForTimeout(1500);
  return true;
}

async function waitForTestcaseExecutionDetails(
  page,
  testcaseName,
  notify = () => {},
  options = {},
) {
  const timeoutMs = Number(options.timeoutMs) || 60000;
  const progressEveryMs = Number(options.progressEveryMs) || 10000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let nextProgressAt = startedAt + progressEveryMs;

  while (Date.now() < deadline) {
    const xray = await resolveXrayScope(page);
    const actualResult = await firstVisibleLocator(xray, ACTUAL_RESULT_TARGETS, 800);
    if (actualResult) {
      logDebug("testcase execution details loaded", {
        testcaseName,
        waitedMs: Date.now() - startedAt,
        pageUrl: page.url(),
        scopeUrl: typeof xray.url === "function" ? xray.url() : page.url(),
      });
      return;
    }
    if (Date.now() >= nextProgressAt) {
      const waited = Math.round((Date.now() - startedAt) / 1000);
      notifyLog(
        notify,
        "info",
        testcaseName,
        `Still waiting for testcase details to load (${waited}s).`,
      );
      nextProgressAt = Date.now() + progressEveryMs;
    }
    await page.waitForTimeout(700);
  }

  logDebug("testcase execution details wait timed out", {
    testcaseName,
    pageUrl: page.url(),
    frameUrls: page.frames().map((frame) => frame.url().slice(0, 160)),
  });
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for testcase execution details after clicking "${testcaseName}". Current URL: ${page.url()}`,
  );
}

async function searchVisibleTable(page, text) {
  const search = await firstVisibleLocator(page, SEARCH_INPUT_SELECTORS, 8000);
  if (!search) {
    logDebug("search input not found", { text });
    return;
  }
  const queries = searchQueriesForText(text);
  for (const query of queries) {
    logDebug("searching visible table", { text, query });
    await clearAndFillSearch(page, search, query);
    if (await waitForRowsToReflectSearch(page, text)) {
      return;
    }
  }
}

async function clearAndFillSearch(page, search, text) {
  await search.click();
  await search.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await search.press("Backspace");
  await search.fill("");
  await ownerPage(page).waitForTimeout(300).catch(() => {});
  await search.fill(text);
  await search.press("Enter").catch(() => {});
  const value = await search.inputValue().catch(() => "");
  logDebug("search input value after fill", { expected: text, actual: value });
  if (normalizeForMatch(value) !== normalizeForMatch(text)) {
    await search.click();
    await search.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await search.type(text, { delay: 10 });
    await search.press("Enter").catch(() => {});
  }
}

async function waitForRowsToReflectSearch(page, text) {
  const expectedTokens = wordTokensForMatch(text);
  const deadline = Date.now() + 12000;
  let lastSamples = [];

  while (Date.now() < deadline) {
    await ownerPage(page).waitForTimeout(700);
    const samples = await visibleRowSamples(page);
    lastSamples = samples;
    const reflected = samples.some((sample) =>
      tokensContainExactSequence(wordTokensForMatch(sample), expectedTokens),
    );
    if (reflected) {
      logDebug("search results reflected query", { text, samples });
      return true;
    }
  }

  logDebug("search results did not reflect query before matching", {
    text,
    samples: lastSamples,
  });
  return false;
}

function searchQueriesForText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  const slashSafe = value.replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim();
  const queries = [value];
  if (slashSafe && normalizeForMatch(slashSafe) !== normalizeForMatch(value)) {
    queries.push(slashSafe);
  }
  return [...new Set(queries.filter(Boolean))];
}

async function findUniqueRowByText(page, expectedText, label) {
  const normalizedExpected = normalizeForMatch(expectedText);
  const expectedTokens = wordTokensForMatch(expectedText);
  await page.waitForSelector("body", { state: "attached", timeout: 30000 });
  const rows = page.locator('[role="row"], tr, .draggable-block-list-item');
  const count = await rows.count();
  const matches = [];
  const inspected = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const rowText = await row.innerText({ timeout: 1200 }).catch(() => "");
    const childTexts = await row
      .locator('td, [role="gridcell"], [role="cell"], a, button, span, div')
      .allTextContents()
      .catch(() => []);
    const candidates = [rowText, ...childTexts]
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const matched = candidates.some((text) => {
      const candidateTokens = wordTokensForMatch(text);
      return (
        normalizeForMatch(text) === normalizedExpected ||
        tokensEqual(candidateTokens, expectedTokens) ||
        tokensContainExactSequence(candidateTokens, expectedTokens)
      );
    });
    inspected.push({
      index,
      candidateCount: candidates.length,
      sample: candidates.slice(0, 5),
      matched,
    });
    if (matched) {
      matches.push(row);
    }
  }

  logDebug("row match inspection", {
    label,
    expectedText,
    rowCount: count,
    matches: matches.length,
    inspected: inspected.slice(0, 20),
  });

  if (matches.length === 0) {
    const samples = await visibleRowSamples(page);
    throw new Error(
      `No ${label} matched "${expectedText}". Visible row samples: ${samples.join(" | ") || "none"}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`Multiple ${label} rows matched "${expectedText}".`);
  }

  return matches[0];
}

async function pasteActualResultEvidence(
  page,
  evidencePngDataUrl,
  notify = () => {},
  testcaseName = "",
) {
  const xray = await resolveXrayScope(page);
  const imageBuffer = dataUrlToBuffer(evidencePngDataUrl);
  notifyLog(notify, "info", testcaseName, "Opening Actual Result editor.");
  const actualResult = await firstVisibleLocator(xray, ACTUAL_RESULT_TARGETS, 15000);
  if (!actualResult) throw new Error("Could not find Actual Result control.");
  await actualResult.click();

  let editor = await findActualResultEditor(xray).catch(() => null);
  if (!editor) {
    logDebug("actual result editor not visible after label click; trying edit fallback", {
      testcaseName,
    });
    await clickActualResultEditFallback(xray, testcaseName);
    editor = await findActualResultEditor(xray);
  }
  await editor.click();
  const beforePaste = await countEditorMedia(editor);
  logDebug("actual result editor ready for paste", { beforePaste });
  notifyLog(notify, "info", testcaseName, "Pasting evidence image.");
  await writeImageToPageClipboard(page, imageBuffer);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  let pasted = await waitForEditorMedia(editor, beforePaste, 10000);
  if (!pasted) {
    logDebug("keyboard image paste did not create media; trying synthetic paste event");
    notifyLog(notify, "warn", testcaseName, "Keyboard paste did not insert media; retrying.");
    await dispatchImagePasteToEditor(editor, imageBuffer);
    pasted = await waitForEditorMedia(editor, beforePaste, 10000);
  }
  if (!pasted) {
    throw new Error("Evidence image was not inserted into Actual Result editor.");
  }
  notifyLog(notify, "info", testcaseName, "Evidence image pasted.");
  logDebug("evidence image inserted into actual result editor", {
    beforePaste,
    afterPaste: await countEditorMedia(editor),
  });
  await refocusActualResultEditorAfterPaste(editor);
  notifyLog(notify, "info", testcaseName, "Waiting for pasted media to stabilize.");
  await waitForEditorMediaStable(editor, 5000);

  logDebug("looking for actual result Save button");
  notifyLog(notify, "info", testcaseName, "Looking for Actual Result Save button.");
  const save = await firstVisibleLocator(xray, SAVE_TARGETS, 10000);
  if (!save) throw new Error("Could not find Save button after pasting evidence.");
  logDebug("clicking actual result Save button", {
    saveText: await save.innerText({ timeout: 1000 }).catch(() => ""),
  });
  notifyLog(notify, "info", testcaseName, "Clicking Actual Result Save.");
  await clickActualResultSaveButton(save, testcaseName);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);
  logDebug("actual result Save click completed");
  notifyLog(notify, "info", testcaseName, "Actual Result saved.");
}

async function clickActualResultSaveButton(save, testcaseName = "") {
  try {
    await save.click({ timeout: 5000 });
    return;
  } catch (error) {
    if (!isPointerInterceptionError(error)) throw error;
    logDebug("actual result Save click intercepted; retrying after dismissing editor media selection", {
      testcaseName,
      message: error.message,
    });
  }

  const page = ownerPage(save);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300).catch(() => {});

  try {
    await save.click({ timeout: 2500 });
    return;
  } catch (error) {
    if (!isPointerInterceptionError(error)) throw error;
    logDebug("actual result Save retry still intercepted; using DOM click fallback", {
      testcaseName,
      message: error.message,
    });
  }

  await save.evaluate((button) => {
    button.click();
  });
}

function isPointerInterceptionError(error) {
  const message = String(error?.message || "");
  return /intercepts pointer events|subtree intercepts pointer events/i.test(message);
}

async function clickTimerStartIfStopped(scope) {
  const timer = await findSectionScope(scope, /timer/i);
  const searchScope = timer || scope;
  const timerText = await searchScope.innerText({ timeout: 1000 }).catch(() => "");
  const play = searchScope
    .locator(
      [
        'button[aria-label*="play" i]',
        'button[title*="play" i]',
        '[role="button"][aria-label*="play" i]',
        '[role="button"][title*="play" i]',
      ].join(", "),
    )
    .first();

  if (!(await play.isVisible({ timeout: 3000 }).catch(() => false))) {
    const clicked =
      (await clickTimerIconStartButton(searchScope, timerText)) ||
      (await clickTimerPanelStartButton(scope));
    logDebug("timer icon start fallback result", { clicked, timerText });
    return clicked;
  }

  await play.click();
  await ownerPage(scope).waitForTimeout(500).catch(() => {});
  logDebug("timer play button clicked", { timerText });
  return true;
}

async function clickTimerIconStartButton(scope, timerText) {
  const normalizedText = normalizeForMatch(timerText);
  const looksStopped =
    !normalizedText ||
    normalizedText.includes("no time logged") ||
    /\b00:00:00\b/.test(normalizedText);
  if (!looksStopped) return false;

  const clicked = await scope
    .locator("button, [role='button']")
    .evaluateAll((nodes) => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return (
          rect.width >= 24 &&
          rect.height >= 24 &&
          rect.width <= 64 &&
          rect.height <= 64 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const buttons = nodes
        .filter(visible)
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .sort((left, right) => left.rect.left - right.rect.left);
      if (!buttons.length) return false;
      buttons[0].node.click();
      return true;
    })
    .catch(() => false);
  if (clicked) await ownerPage(scope).waitForTimeout(700).catch(() => {});
  return clicked;
}

async function clickTimerPanelStartButton(scope) {
  const result = await scope
    .locator("body")
    .evaluate((body) => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const isSquareButton = (node) => {
        if (!visible(node)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width >= 24 && rect.height >= 24 && rect.width <= 70 && rect.height <= 70;
      };
      const panelCandidates = [...body.querySelectorAll("section, fieldset, div, article")]
        .filter(visible)
        .map((node) => {
          const text = (node.innerText || "").replace(/\s+/g, " ").trim();
          const buttons = [...node.querySelectorAll("button, [role='button']")]
            .filter(isSquareButton)
            .map((button) => ({ button, rect: button.getBoundingClientRect() }));
          const rect = node.getBoundingClientRect();
          return { node, text, buttons, area: rect.width * rect.height };
        })
        .filter((item) => /\bTimer\b/i.test(item.text) && item.buttons.length);

      panelCandidates.sort((left, right) => {
        const textDiff = left.text.length - right.text.length;
        return textDiff || left.area - right.area;
      });

      const panel = panelCandidates.find((item) =>
        /no time logged|00:00:00/i.test(item.text),
      );
      if (!panel) {
        return { clicked: false, reason: "no stopped timer panel" };
      }

      panel.buttons.sort((left, right) => left.rect.left - right.rect.left);
      const target = panel.buttons[0];
      target.button.click();
      return {
        clicked: true,
        panelText: panel.text,
        x: Math.round(target.rect.left),
        y: Math.round(target.rect.top),
      };
    })
    .catch((error) => ({ clicked: false, reason: error.message }));
  if (result.clicked) await ownerPage(scope).waitForTimeout(700).catch(() => {});
  logDebug("timer panel start search result", result);
  return result.clicked;
}

async function setExecutionStatus(scope, status) {
  const normalized = normalizeWorkflowStatus(status);
  if (normalized === "unset") {
    logDebug("local execution status unset; leaving Xray status unchanged");
    return false;
  }

  const section = await findSectionScope(scope, /execution\s+status/i);
  const searchScope = section || scope;
  const selectors =
    normalized === "pass"
      ? [
          'button[aria-label*="pass" i]',
          'button[title*="pass" i]',
          '[role="button"][aria-label*="pass" i]',
          '[role="button"][title*="pass" i]',
          '[aria-label*="passed" i]',
          '[title*="passed" i]',
        ]
      : [
          'button[aria-label*="fail" i]',
          'button[title*="fail" i]',
          '[role="button"][aria-label*="fail" i]',
          '[role="button"][title*="fail" i]',
          '[aria-label*="failed" i]',
          '[title*="failed" i]',
        ];

  const explicit = searchScope.locator(selectors.join(", ")).first();
  if (await explicit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await explicit.click();
    await ownerPage(scope).waitForTimeout(500).catch(() => {});
    logDebug("xray execution status clicked", { status: normalized, strategy: "explicit" });
    return true;
  }

  const clicked = await clickStatusSquareByColor(searchScope, normalized);
  logDebug("xray execution status click result", {
    status: normalized,
    clicked,
    strategy: "color",
  });
  return clicked;
}

async function requireExecutionStatus(
  scope,
  status,
  setStatus = setExecutionStatus,
  verifyStatus = waitForExecutionStatusConfirmation,
) {
  const normalized = normalizeWorkflowStatus(status);
  const clicked = await setStatus(scope, normalized);
  logDebug("xray execution status update required result", {
    status: normalized,
    clicked,
  });
  if (!clicked) {
    throw new Error(`Could not set Xray status to ${normalized}`);
  }
  const confirmed = await verifyStatus(scope, normalized);
  logDebug("xray execution status confirmation result", {
    status: normalized,
    confirmed,
  });
  if (!confirmed) {
    throw new Error(`Xray status did not confirm as ${normalized}`);
  }
  return true;
}

async function waitForExecutionStatusConfirmation(scope, status, timeoutMs = 8000) {
  const expected = normalizeWorkflowStatus(status) === "fail" ? "failed" : "passed";
  const deadline = Date.now() + timeoutMs;
  let lastText = "";

  while (Date.now() < deadline) {
    const section = await findSectionScope(scope, /execution\s+status/i);
    const searchScope = section || scope;
    const text = await locatorInnerText(searchScope, 1000);
    lastText = text || lastText;
    if (getXrayRowExecutionStatusFromText(text) === expected) {
      return true;
    }
    await ownerPage(scope).waitForTimeout(500).catch(() => {});
  }

  logDebug("xray execution status confirmation timed out", {
    expected,
    lastText: lastText.slice(0, 500),
  });
  return false;
}

async function locatorInnerText(scope, timeout = 1000) {
  if (typeof scope.innerText === "function") {
    return scope.innerText({ timeout }).catch(() => "");
  }
  if (typeof scope.locator === "function") {
    return scope.locator("body").innerText({ timeout }).catch(() => "");
  }
  return "";
}

async function findSectionScope(scope, labelPattern) {
  const candidates = scope.locator("section, fieldset, div, form, article");
  const count = Math.min(await candidates.count().catch(() => 0), 250);
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = await candidate.innerText({ timeout: 500 }).catch(() => "");
    if (labelPattern.test(text)) {
      matches.push({
        locator: candidate,
        textLength: text.length,
      });
    }
  }
  matches.sort((left, right) => left.textLength - right.textLength);
  return matches[0]?.locator || null;
}

async function clickStatusSquareByColor(scope, status) {
  const clicked = await scope
    .locator("button, [role='button'], div, span")
    .evaluateAll((nodes, targetStatus) => {
      const colorMatches = (style) => {
        const values = [
          style.backgroundColor,
          style.borderColor,
          style.color,
        ].join(" ");
        if (targetStatus === "pass") {
          return /rgb\((?:[0-9]{1,2}|1[0-9]{2}),\s*(?:1[2-9][0-9]|2[0-5][0-9]),\s*(?:[0-9]{1,2}|1[01][0-9])\)/.test(values);
        }
        return /rgb\((?:1[2-9][0-9]|2[0-5][0-9]),\s*(?:[0-9]{1,2}|1[01][0-9]),\s*(?:[0-9]{1,2}|1[01][0-9])\)/.test(values);
      };

      const visibleSquares = nodes
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10 || rect.width > 80 || rect.height > 80) return false;
          const style = window.getComputedStyle(node);
          return style.visibility !== "hidden" && style.display !== "none" && colorMatches(style);
        })
        .sort((left, right) => {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return leftRect.left - rightRect.left;
        });

      const target = visibleSquares[0];
      if (!target) return false;
      target.click();
      return true;
    }, status)
    .catch(() => false);
  if (clicked) await ownerPage(scope).waitForTimeout(500).catch(() => {});
  return clicked;
}

async function findActualResultEditor(page) {
  const selectors = [
    '[contenteditable="true"]',
    'textarea:visible',
    '[role="textbox"]',
    ".ProseMirror",
  ];
  const editor = await firstVisibleLocator(page, selectors, 10000);
  if (!editor) throw new Error("Could not find Actual Result editor.");
  return editor;
}

async function clickActualResultEditFallback(scope, testcaseName = "") {
  const section = await findSectionScope(scope, /actual\s+result/i);
  const sectionText = section ? await locatorInnerText(section, 1000) : "";
  const edit =
    (section ? await findActualResultEditButton(section, 2500) : null) ||
    (await findActualResultEditButton(scope, 2500));

  if (edit) {
    logDebug("clicking actual result Edit fallback", {
      testcaseName,
      editText: await edit.innerText({ timeout: 1000 }).catch(() => ""),
    });
    await edit.click();
    await ownerPage(scope).waitForTimeout(700).catch(() => {});
    return true;
  }

  const clickedPreview = await clickActualResultPreviewEditor(scope);
  if (clickedPreview) {
    logDebug("clicked actual result preview edit fallback", { testcaseName });
    await ownerPage(scope).waitForTimeout(700).catch(() => {});
    return true;
  }

  {
    logDebug("actual result Edit fallback button not found", {
      testcaseName,
      sectionText: sectionText.slice(0, 500),
      scopeText: (await locatorInnerText(scope, 1000)).slice(0, 500),
    });
    return false;
  }
}

async function findActualResultEditButton(scope, timeoutMs = 5000) {
  return firstVisibleLocator(
    scope,
    [
      'button:has-text("Edit")',
      'button[aria-label*="Edit" i]',
      '[role="button"]:has-text("Edit")',
      '[role="button"][aria-label*="Edit" i]',
    ],
    timeoutMs,
  );
}

async function clickActualResultPreviewEditor(scope) {
  return scope
    .locator("body")
    .evaluate((body) => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const textOf = (node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      const candidates = [...body.querySelectorAll('[title*="Click to edit" i]')]
        .filter(visible)
        .map((node) => {
          let container = node;
          for (let depth = 0; depth < 4 && container.parentElement; depth += 1) {
            const parentText = textOf(container.parentElement);
            if (/actual\s+result/i.test(parentText)) {
              container = container.parentElement;
              break;
            }
            container = container.parentElement;
          }
          const rect = node.getBoundingClientRect();
          return {
            node,
            text: textOf(node),
            containerText: textOf(container),
            y: rect.top,
          };
        })
        .filter((item) => /actual\s+result/i.test(item.containerText));

      candidates.sort((left, right) => left.y - right.y);
      const target =
        candidates.find((item) => /preview unavailable|actual\s+result/i.test(item.text)) ||
        candidates[0];
      if (!target) return false;
      target.node.click();
      return true;
    })
    .catch(() => false);
}

async function countEditorMedia(editor) {
  return editor
    .evaluate((element) => {
      return element.querySelectorAll(
        'img, [data-node-type*="media" i], [data-testid*="media" i], [data-testid*="attachment" i], .media, .image',
      ).length;
    })
    .catch(() => 0);
}

async function waitForEditorMedia(editor, previousCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await countEditorMedia(editor);
    if (count > previousCount) return true;
    await ownerPage(editor).waitForTimeout(500).catch(() => {});
  }
  return false;
}

async function waitForEditorMediaStable(editor, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous = await countEditorMedia(editor);
  let stableReads = 0;

  while (Date.now() < deadline) {
    await ownerPage(editor).waitForTimeout(500).catch(() => {});
    const current = await countEditorMedia(editor);
    if (current === previous && current > 0) {
      stableReads += 1;
      if (stableReads >= 2) {
        logDebug("actual result editor media stable", { mediaCount: current });
        return true;
      }
    } else {
      stableReads = 0;
      previous = current;
    }
  }

  logDebug("actual result editor media stability wait timed out", {
    mediaCount: await countEditorMedia(editor),
  });
  return false;
}

async function refocusActualResultEditorAfterPaste(editor) {
  await editor.scrollIntoViewIfNeeded().catch(() => {});
  await editor.click({ timeout: 5000 }).catch((error) => {
    logDebug("actual result editor refocus click failed", { message: error.message });
  });
  await ownerPage(editor).waitForTimeout(500).catch(() => {});
  logDebug("actual result editor clicked after paste", {
    mediaCount: await countEditorMedia(editor),
  });
}

async function dispatchImagePasteToEditor(editor, imageBuffer) {
  const pngBase64 = imageBuffer.toString("base64");
  await editor.evaluate(async (element, base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const blob = new Blob([bytes], { type: "image/png" });
    const file = new File([blob], "xray-evidence.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    element.dispatchEvent(event);
  }, pngBase64);
}

async function writeImageToPageClipboard(page, imageBuffer) {
  const pngBase64 = imageBuffer.toString("base64");
  await page.evaluate(async (base64) => {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      throw new Error("Browser clipboard image writing is unavailable.");
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const blob = new Blob([bytes], { type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }, pngBase64);
}

async function firstVisibleLocator(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = selector.startsWith("text=")
        ? page.locator(selector).first()
        : page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    await ownerPage(page).waitForTimeout(300);
  }
  return null;
}

async function findXrayFrameWithContent(page) {
  const candidates = page
    .frames()
    .filter((item) => item !== page.mainFrame() && XRAY_FRAME_URL_PATTERN.test(item.url()));
  for (const candidate of candidates) {
    const hasContent = await candidate
      .evaluate(() => Boolean(document.body && document.body.innerText.trim()))
      .catch(() => false);
    if (hasContent) return { candidates, frame: candidate };
  }
  return { candidates, frame: null };
}

async function resolveXrayScope(page, options = {}) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1500);

  // Forge-hosted Xray renders inside *.atlassian-dev.net frames. Jira also loads empty
  // helper frames from the same host, so prefer the candidate that actually has content.
  // Right after a route change every frame is still empty for several seconds (live: the
  // real one fills at ~4s), so wait for content rather than locking onto candidates[0],
  // a helper frame that stays empty forever.
  const contentTimeoutMs = Number(options.contentTimeoutMs ?? 20000);
  const contentDeadline = Date.now() + contentTimeoutMs;
  let found = await findXrayFrameWithContent(page);
  while (!found.frame && found.candidates.length && Date.now() < contentDeadline) {
    await page.waitForTimeout(500);
    found = await findXrayFrameWithContent(page);
  }
  if (found.frame) return found.frame;
  if (found.candidates.length) {
    return found.candidates[0];
  }

  const iframe = page
    .locator(
      'iframe[src*="atlassian-dev" i], iframe[src*="xray" i], iframe[src*="xpandit" i], iframe[src*="atlassian-connect" i], iframe[title*="Xray" i]',
    )
    .first();
  const iframeElement = await iframe.elementHandle({ timeout: 5000 }).catch(() => null);
  const contentFrame = iframeElement ? await iframeElement.contentFrame() : null;
  return contentFrame || page;
}

async function waitForXrayAppReady(page, notify, options = {}) {
  const deadline = Date.now() + (Number(options.timeoutMs) || 3 * 60 * 1000);
  notify("running", "Waiting for Xray test executions to load.");

  while (Date.now() < deadline) {
    if (await hasLoginChallenge(page)) {
      if (normalizeBrowserMode(options.browserMode) === "headless") {
        throw new Error(
          "The Jira session expired during the run and headless mode cannot show a login page. Start the workflow again; a visible browser window will open for login.",
        );
      }
      await waitForManualLogin(page, notify, { signal: options.signal });
      await page.goto(JIRA_PROJECT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      await openXrayTestingBoard(page);
    }

    const xray = await resolveXrayScope(page);
    const hasSearch = Boolean(
      await firstVisibleLocator(xray, SEARCH_INPUT_SELECTORS, 1500),
    );
    const hasRows = (await xray.locator('[role="row"], tr, .draggable-block-list-item').count()) > 0;
    if (hasSearch || hasRows) return;

    await page.waitForTimeout(1000);
  }

  throw new Error(
    "Xray test executions did not load within 3 minutes. Complete Jira login/2FA and confirm you can access the Xray test executions page.",
  );
}

function ownerPage(scope) {
  return typeof scope.page === "function" ? scope.page() : scope;
}

async function visibleRowSamples(page) {
  const rows = page.locator('[role="row"], tr, .draggable-block-list-item');
  const count = Math.min(await rows.count(), 8);
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const text = normalizeForMatch(await row.innerText().catch(() => ""));
    if (text) samples.push(text.slice(0, 160));
  }
  return samples;
}

async function collectActionableElements(locator) {
  return locator
    .evaluate((element) => {
      return [...element.querySelectorAll("a, button, [role='button']")].map(
        (node, index) => ({
          index,
          tag: node.tagName.toLowerCase(),
          text: (node.textContent || "").replace(/\s+/g, " ").trim(),
          ariaLabel: node.getAttribute("aria-label") || "",
          title: node.getAttribute("title") || "",
          href: node.getAttribute("href") || "",
          className: node.getAttribute("class") || "",
          testId: node.getAttribute("data-testid") || "",
        }),
      );
    })
    .catch(() => []);
}

module.exports = {
  buildChromiumLaunchOptions,
  clickActualResultEditFallback,
  clickActualResultSaveButton,
  clickTimerStartIfStopped,
  closeSharedBrowser,
  dataUrlToBuffer,
  getXrayRowExecutionStatus,
  getXrayRowExecutionStatusFromText,
  isPointerInterceptionError,
  localSkipLabel,
  loginInVisibleBrowser,
  normalizeBrowserMode,
  normalizeForMatch,
  normalizeWorkflowStatus,
  openTestExecution,
  ensureXrayTestExecutionsList,
  openJiraSignedIn,
  openTestcaseExecution,
  openXrayTestingBoard,
  prepareXrayTestExecutionsList,
  requireExecutionStatus,
  resolveXrayScope,
  runXrayWorkflow,
  setExecutionStatus,
  shouldSkipExecutedRow,
  tokensContainExactSequence,
  tokensEqual,
  throwIfWorkflowCancelled,
  wordTokensForMatch,
};
