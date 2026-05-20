const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const {
  ACTUAL_RESULT_TARGETS,
  PLAY_BUTTON_FALLBACK_SELECTOR,
  SAVE_TARGETS,
  SEARCH_INPUT_SELECTORS,
  TEST_EXECUTION_LINK_FALLBACK_SELECTOR,
  XRAY_TEST_EXECUTIONS_URL,
} = require("./selectors");
const {
  authStatePath,
  hasLoginChallenge,
  hasSavedJiraSession,
  isLoginUrl,
  saveJiraSession,
  waitForManualLogin,
} = require("./jira-session");

const DEBUG_LOG_PATH = path.resolve(__dirname, "workflow-debug.log");

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

function normalizeWorkflowStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "fail" ? "fail" : "pass";
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
  notifyLog(notify, "info", "", `Launching Playwright in ${browserMode} mode.`);
  const browser = await chromium.launch(buildChromiumLaunchOptions(browserMode));
  options.onBrowser?.(browser);
  const abortBrowser = () => {
    browser.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", abortBrowser, { once: true });
  throwIfWorkflowCancelled(options.signal);

  const contextOptions = hasSavedJiraSession()
    ? { storageState: authStatePath() }
    : {};
  const context = await browser.newContext({
    ...contextOptions,
    viewport: { width: 1920, height: 1080 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const results = [];

  try {
    throwIfWorkflowCancelled(options.signal);
    notifyLog(notify, "info", "", "Opening Jira Xray test executions.");
    await page.goto(XRAY_TEST_EXECUTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    if (isLoginUrl(page.url()) || (await hasLoginChallenge(page))) {
      await waitForManualLogin(page, notify);
      await page.goto(XRAY_TEST_EXECUTIONS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
    } else {
      await saveJiraSession(context);
    }

    await waitForXrayAppReady(page, notify);
    throwIfWorkflowCancelled(options.signal);
    notifyLog(notify, "info", "", `Searching execution "${payload.testExecutionSummary}".`);
    await openTestExecution(page, payload.testExecutionSummary);

    for (const item of payload.items) {
      throwIfWorkflowCancelled(options.signal);
      let currentStep = "Starting testcase";
      try {
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
          results.push({
            testcaseName: item.testcaseName,
            status: "skipped",
            localStatus,
            rowStatus: openResult.rowStatus,
            message: `Skipped because Xray row is already ${openResult.rowStatus}.`,
          });
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
        results.push({
          testcaseName: item.testcaseName,
          status: "success",
          localStatus,
          message: "Evidence uploaded.",
        });
      } catch (error) {
        throwIfWorkflowCancelled(options.signal);
        const message = `${currentStep} failed: ${error.message}`;
        notifyLog(notify, "error", item.testcaseName, message);
        results.push({
          testcaseName: item.testcaseName,
          status: "failed",
          localStatus: normalizeWorkflowStatus(item.status),
          message,
        });
      }
    }

    const failed = results.filter((item) => item.status === "failed");
    const skipped = results.filter((item) => item.status === "skipped");
    return {
      status: failed.length ? "partial" : "success",
      message: failed.length
        ? `${failed.length} testcase upload failed.`
        : skipped.length
          ? `Workflow completed; ${skipped.length} already executed testcase skipped.`
          : "All evidence uploaded to Xray.",
      results,
    };
  } finally {
    options.signal?.removeEventListener("abort", abortBrowser);
    await browser.close().catch(() => {});
  }
}

async function openTestExecution(page, summary) {
  await page.waitForLoadState("domcontentloaded");
  const xray = await resolveXrayScope(page);
  logDebug("opening test execution", {
    summary,
    pageUrl: page.url(),
    scopeUrl: typeof xray.url === "function" ? xray.url() : page.url(),
  });
  await searchVisibleTable(xray, summary);
  const row = await findUniqueRowByText(xray, summary, "test execution summary");
  await row.click();

  const rowLink = row.locator("a").filter({ hasText: summary }).first();
  if (await rowLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      rowLink.click(),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    return;
  }

  const selectedExecutionLink = xray.locator(TEST_EXECUTION_LINK_FALLBACK_SELECTOR).first();
  if (await selectedExecutionLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      selectedExecutionLink.click(),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    return;
  }

  await row.click({ button: "right" });
  const openMenuItem = xray.getByRole("menuitem", { name: /^open$/i });
  if (await openMenuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      openMenuItem.click(),
    ]);
  } else {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      row.dblclick(),
    ]);
  }
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
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
    await waitForTestcaseExecutionDetails(page, testcaseName);
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
    await waitForTestcaseExecutionDetails(page, testcaseName);
    await afterTestcaseOpenDryRun();
    return { status: "opened", rowStatus };
  }

  const fallback = xray.locator(PLAY_BUTTON_FALLBACK_SELECTOR).first();
  if (await fallback.isVisible({ timeout: 3000 }).catch(() => false)) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      fallback.click(),
    ]);
    await waitForTestcaseExecutionDetails(page, testcaseName);
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
    await waitForTestcaseExecutionDetails(page, testcaseName);
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
    await waitForTestcaseExecutionDetails(page, testcaseName);
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

async function clickFarRightRowAction(page, row, testcaseName) {
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

async function waitForTestcaseExecutionDetails(page, testcaseName) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const xray = await resolveXrayScope(page);
    const actualResult = await firstVisibleLocator(xray, ACTUAL_RESULT_TARGETS, 800);
    if (actualResult) {
      logDebug("testcase execution details loaded", {
        testcaseName,
        pageUrl: page.url(),
        scopeUrl: typeof xray.url === "function" ? xray.url() : page.url(),
      });
      return;
    }
    await page.waitForTimeout(700);
  }

  throw new Error(
    `Timed out waiting for testcase execution details after clicking "${testcaseName}".`,
  );
}

async function searchVisibleTable(page, text) {
  const search = await firstVisibleLocator(page, SEARCH_INPUT_SELECTORS, 8000);
  if (!search) {
    logDebug("search input not found", { text });
    return;
  }
  logDebug("searching visible table", { text });
  await clearAndFillSearch(page, search, text);
  await waitForRowsToReflectSearch(page, text);
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
      return;
    }
  }

  logDebug("search results did not reflect query before matching", {
    text,
    samples: lastSamples,
  });
}

async function findUniqueRowByText(page, expectedText, label) {
  const normalizedExpected = normalizeForMatch(expectedText);
  const expectedTokens = wordTokensForMatch(expectedText);
  await page.waitForSelector("body", { timeout: 30000 });
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
  const bytes = [...imageBuffer];
  await editor.evaluate(async (element, pngBytes) => {
    const blob = new Blob([new Uint8Array(pngBytes)], { type: "image/png" });
    const file = new File([blob], "xray-evidence.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    element.dispatchEvent(event);
  }, bytes);
}

async function writeImageToPageClipboard(page, imageBuffer) {
  const bytes = [...imageBuffer];
  await page.evaluate(async (pngBytes) => {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      throw new Error("Browser clipboard image writing is unavailable.");
    }
    const blob = new Blob([new Uint8Array(pngBytes)], { type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }, bytes);
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

async function resolveXrayScope(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1500);

  const frame = page
    .frames()
    .find((item) =>
      /xray|xpandit|testing-board|atlassian-connect|jira/i.test(item.url()),
    );
  if (frame && frame !== page.mainFrame()) {
    return frame;
  }

  const iframe = page
    .locator(
      'iframe[src*="xray" i], iframe[src*="xpandit" i], iframe[src*="atlassian-connect" i], iframe[title*="Xray" i]',
    )
    .first();
  const iframeElement = await iframe.elementHandle({ timeout: 5000 }).catch(() => null);
  const contentFrame = iframeElement ? await iframeElement.contentFrame() : null;
  return contentFrame || page;
}

async function waitForXrayAppReady(page, notify) {
  const deadline = Date.now() + 3 * 60 * 1000;
  notify("running", "Waiting for Xray test executions to load.");

  while (Date.now() < deadline) {
    if (await hasLoginChallenge(page)) {
      await waitForManualLogin(page, notify);
      await page.goto(XRAY_TEST_EXECUTIONS_URL, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
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
  dataUrlToBuffer,
  getXrayRowExecutionStatus,
  getXrayRowExecutionStatusFromText,
  isPointerInterceptionError,
  normalizeBrowserMode,
  normalizeForMatch,
  normalizeWorkflowStatus,
  openTestExecution,
  openTestcaseExecution,
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
