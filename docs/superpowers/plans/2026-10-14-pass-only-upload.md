# Pass-Only Upload Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-workspace "Upload Pass only" setting. When on, Fail test cases are skipped by the Xray workflow (like Blocked / N/A / Not Run). When off (default), behavior is unchanged.

**Architecture:** The flag lives in `workspace.workflow.passOnly` next to `browserMode`. The frontend enforces it (disables Start Workflow, filters the workspace queue) and also sends `passOnly` in the `/workflow/start` payload. The server validates it and `runXrayWorkflow` skips Fail items too (defense in depth, same pattern as Blocked).

**Tech Stack:** Vanilla JS in single `xray-md-evidence.html`, CommonJS Node server, Playwright, `node --test`.

**Spec:** No separate spec doc. Decisions from the 2026-10-14 conversation: branch `only-pass-upload`; scope = skip non-Pass uploads; Fail handling = **toggle**, off by default.

## Global Constraints

- `xray-md-evidence.html` stays one self-contained file: no external scripts/CSS, no build step.
- Plain CommonJS on the Node side, no TypeScript.
- Product name is spelled **NeuString** (capital S) in docs/UI copy.
- Default (toggle off) must behave exactly as today. Existing tests must keep passing.
- Unset status already uploads as Pass (`defaultUnsetStatusToPass`); it stays eligible when the toggle is on.
- No real Jira/Xray credentials, URLs or PII in tests or fixtures.
- App version bumps from `1.6.2` to `1.6.3` (server changes). Must stay in sync in `xray-md-evidence.html` (`APP_VERSION`), `package.json`, `package-lock.json`.

## Review Focus

- Old saved workspaces and imported JSON have no `passOnly` key. Expected: treated as `false`, no crash.
- JSON import/export and Gist sync round-trip `passOnly` (via `normalizeWorkflowSettings`). Expected: value preserved.
- Toggle changed while a queue is running. Decision: **blocked**. Checkbox and Save are disabled while `workflowState.queueActive`, and `saveWorkflowSettingsFromUi` refuses with a toast. Test in Task 1.
- A queue where every pending case is Fail with the toggle on. Decision: no special handling; the existing "No test cases with evidence are pending Xray upload." toast is enough and the user decides.
- Server receives `passOnly: "true"` (string) or garbage. Expected: only boolean `true` enables it.

**Security note:** none of this touches auth, crypto or deletion. It reads a boolean from a local request body. Human review still recommended for the `server.js` payload change.

## File Structure

- Modify `xray-md-evidence.html`: settings checkbox, `workflowState.passOnly`, persistence, skip helper, payload field.
- Modify `workflow/server.js`: `validateWorkflowPayload` passes `passOnly` through.
- Modify `workflow/xray-workflow.js`: new exported `localSkipLabel`, used in the item loop.
- Modify `tests/xray-md-evidence.test.js`, `workflow/xray-workflow.test.js`.
- Modify `install-windows.ps1`: stop `exit` from closing the user's terminal; keep the saved Jira session across re-installs.
- Modify `tests/index-page.test.js`: assert both installer fixes.
- Modify `README.md`: document the setting. (Existing uncommitted README change is an unrelated branch-cleanup snippet; do not stage it with this work.)

---

### Task 1: Frontend setting, persistence and skip logic

**Files:**
- Modify: `xray-md-evidence.html` (settings markup ~2349-2358, `els` ~2600, `workflowState` ~2513, `workflowPanelHtml` ~3759, `loadWorkflowSettings` ~4206, `readLegacyWorkflowSettings` ~4230, `saveWorkflowSettings` ~4249, `saveWorkflowSettingsFromUi` ~4276, `renderWorkflowSettingsUi` ~4288, `normalizeWorkflowSettings` ~4310, `startXrayWorkflowForTc` ~4415, `startXrayWorkflowForWorkspace` ~4425, payload ~4571, `isUploadSkippedStatus` ~6435)
- Test: `tests/xray-md-evidence.test.js` (append at end)

**Interfaces:**
- Consumes: `normalizeStatus(value)`, `isUploadSkippedStatus(value)`, `workflowState`, `activeWorkspace()`.
- Produces: `workflowState.passOnly: boolean`; `workspace.workflow.passOnly: boolean`; `isUploadSkippedForWorkflow(tc): boolean`; request body field `passOnly: boolean` on `POST /workflow/start`.

- [ ] **Step 1: Write the failing tests** (append to `tests/xray-md-evidence.test.js`)

```js
test("Upload Pass only setting persists and disables Start Workflow for Fail cases", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Failing flow", status: "fail" }),
        testCaseFixture({ id: "TC-002", title: "Passing flow", status: "pass" }),
      ]),
    );
    await stubWorkflowService(page);

    await page.goto(htmlUrl);
    await page.waitForSelector("article.tc-card");
    const startFail = page.locator('button[data-action="start-workflow"][data-tc="TC-001"]');
    assert.equal(await startFail.isDisabled(), false, "default off: Fail can start");

    await page.locator("#settingsDrawerOpenBtn").click();
    await page.locator("#workflowPassOnlySetting").check();
    await page.locator("#saveWorkflowSettingsBtn").click();

    assert.equal(await startFail.isDisabled(), true);
    assert.equal(
      await page
        .locator('button[data-action="start-workflow"][data-tc="TC-002"]')
        .isDisabled(),
      false,
    );
    const stored = await readStoredState(page);
    assert.equal(stored.workspaces[0].workflow.passOnly, true);

    await page.reload();
    await page.waitForSelector("article.tc-card");
    assert.equal(await startFail.isDisabled(), true, "survives reload");
  } finally {
    await browser.close();
  }
});

test("Upload Pass only excludes Fail cases from the workspace queue and sends passOnly", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let requestBody = null;

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Failing flow", status: "fail", xrayUploaded: false }),
        testCaseFixture({ id: "TC-002", title: "Passing flow", status: "pass", xrayUploaded: false }),
      ]),
    );
    await page.addInitScript(() => {
      window.confirm = () => true;
    });
    await page.route("http://127.0.0.1:39291/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/health") {
        await route.fulfill({ json: { status: "ready" } });
        return;
      }
      if (url.pathname === "/workflow/start") {
        requestBody = JSON.parse(route.request().postData() || "{}");
        await route.fulfill({
          json: { runId: "run-pass-only", status: "queued", message: "Workflow queued." },
        });
        return;
      }
      await route.fulfill({
        json: {
          runId: "run-pass-only",
          status: "success",
          message: "Workflow finished.",
          payloadSummary: { itemCount: 1, browserMode: "headless" },
          logs: [],
          results: [{ testcaseName: "Passing flow", status: "success" }],
        },
      });
    });

    await page.goto(htmlUrl);
    await page.locator("#settingsDrawerOpenBtn").click();
    await page.locator("#workflowPassOnlySetting").check();
    await page.locator("#saveWorkflowSettingsBtn").click();
    await page.locator("#startWorkspaceWorkflowBtn").click();
    await page.locator(".toast", { hasText: "Workflow queue completed" }).waitFor();

    assert.deepEqual(
      requestBody.items.map((item) => item.testcaseName),
      ["Passing flow"],
    );
    assert.equal(requestBody.passOnly, true);
  } finally {
    await browser.close();
  }
});
```

Note: if `workspaceWithUploadedCases` does not seed a saved `workflow.testExecutionSummary`, copy whatever the adjacent queue test (~line 2984) does to get past the "save the summary" guard. Do not invent a new fixture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="Upload Pass only" tests/xray-md-evidence.test.js`
Expected: both FAIL (`#workflowPassOnlySetting` not found / timeout).

- [ ] **Step 3: Implement**

3a. Settings markup: add after the `workflow-mode-options` div (after line ~2358):

```html
            <label class="workflow-mode-option" style="display: block; margin-top: 8px">
              <input id="workflowPassOnlySetting" type="checkbox" />
              Upload Pass only (skip Fail test cases)
            </label>
```

3b. `workflowState` (~2513): add `passOnly: false,` after `browserMode: "headless",`.

3c. `els` (~2601): add `workflowPassOnlySetting: $("workflowPassOnlySetting"),` after `saveWorkflowSettingsBtn`.

3d. `loadWorkflowSettings`: in the `if (workspace?.workflow)` branch add `workflowState.passOnly = workspace.workflow.passOnly === true;`, and in the else branch `workflowState.passOnly = false;`. Leave the legacy migration literal alone (legacy storage never had the key; `=== true` handles undefined).

3e. `saveWorkflowSettings`: after the `browserMode` assignment add

```js
          workflowState.passOnly = (options.passOnly ?? workflowState.passOnly) === true;
```

and add `passOnly: workflowState.passOnly,` to the `workspace.workflow = {...}` literal.

3f. `saveWorkflowSettingsFromUi`: add to the options object

```js
            passOnly: Boolean(els.workflowPassOnlySetting?.checked),
```

3g. `renderWorkflowSettingsUi`: before the `saveWorkflowSettingsBtn` block add

```js
          if (els.workflowPassOnlySetting) {
            els.workflowPassOnlySetting.checked = workflowState.passOnly;
            els.workflowPassOnlySetting.disabled = !activeWorkspace();
          }
```

3h. `normalizeWorkflowSettings`: add `passOnly: value.passOnly === true,` to the returned object.

3i. Helper next to `isUploadSkippedStatus` (~6437):

```js
        // Statuses skipped for this run: always-skipped ones, plus Fail when "Upload Pass only" is on.
        function isUploadSkippedForWorkflow(tc) {
          if (isUploadSkippedStatus(tc.status)) return true;
          return workflowState.passOnly && normalizeStatus(tc.status) === "fail";
        }
```

3j. Replace the three call sites:
- `workflowPanelHtml`: `isUploadSkippedStatus(tc.status)` -> `isUploadSkippedForWorkflow(tc)`.
- `startXrayWorkflowForWorkspace` filter: `!isUploadSkippedStatus(tc.status)` -> `!isUploadSkippedForWorkflow(tc)`.
- `startXrayWorkflowForTc`: replace the check and toast with

```js
          if (isUploadSkippedForWorkflow(tc)) {
            toast(
              isUploadSkippedStatus(tc.status)
                ? "Blocked, N/A and Not Run test cases are not uploaded to Xray."
                : "Upload Pass only is on, so Fail test cases are not uploaded to Xray.",
            );
            return;
          }
```

3k. Payload (~4571): add `passOnly: workflowState.passOnly,` after `browserMode: workflowState.browserMode,` in the `JSON.stringify({...})` body of `/workflow/start`.

3l. Block changes during a running queue.
- `renderWorkflowSettingsUi`: set `els.workflowPassOnlySetting.disabled = !activeWorkspace() || workflowState.queueActive;` (replaces the line from 3g) and `els.saveWorkflowSettingsBtn.disabled = !activeWorkspace() || workflowState.queueActive;`.
- `saveWorkflowSettingsFromUi`: first line of the function:

```js
          if (workflowState.queueActive) {
            toast("Wait for the running workflow queue to finish before changing settings.");
            return;
          }
```

- In `startXrayWorkflowQueue`, call `renderWorkflowSettingsUi();` right after `workflowState.queueActive = true;` and again wherever `queueActive` is set back to `false` (find with Grep `queueActive = false`), so the controls disable and re-enable.

3m. Add this test (append to `tests/xray-md-evidence.test.js`). It holds the status poll open so the queue stays active:

```js
test("Upload Pass only setting is locked while a workflow queue is running", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Passing flow", status: "pass", xrayUploaded: false }),
      ]),
    );
    await page.addInitScript(() => {
      window.confirm = () => true;
    });
    await page.route("http://127.0.0.1:39291/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/health") {
        await route.fulfill({ json: { status: "ready" } });
        return;
      }
      if (url.pathname === "/workflow/start") {
        await route.fulfill({
          json: { runId: "run-lock", status: "queued", message: "Workflow queued." },
        });
        return;
      }
      await route.fulfill({
        json: {
          runId: "run-lock",
          status: "running",
          message: "Running.",
          payloadSummary: { itemCount: 1, browserMode: "headless" },
          logs: [],
          results: [],
        },
      });
    });

    await page.goto(htmlUrl);
    await page.locator("#startWorkspaceWorkflowBtn").click();
    await page.locator("#settingsDrawerOpenBtn").click();
    await page.waitForFunction(
      () => document.querySelector("#workflowPassOnlySetting")?.disabled === true,
    );
    assert.equal(await page.locator("#saveWorkflowSettingsBtn").isDisabled(), true);
  } finally {
    await browser.close();
  }
});
```

If the settings drawer cannot be opened while the queue runs (overlay), open it first, then start the queue from the page; adjust order, not the assertions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="Upload Pass only" tests/xray-md-evidence.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full frontend suite**

Run: `node --test tests/*.test.js`
Expected: all PASS (no regressions; default-off behavior unchanged).

- [ ] **Step 6: Commit**

```bash
git add xray-md-evidence.html tests/xray-md-evidence.test.js
git commit -m "feat: add Upload Pass only workflow setting"
```

---

### Task 2: Server validation and workflow skip

**Files:**
- Modify: `workflow/server.js:142-168` (`validateWorkflowPayload`)
- Modify: `workflow/xray-workflow.js:140-153`, `:241-254`, exports at `:1447`
- Test: `workflow/xray-workflow.test.js` (append; add `localSkipLabel` to the existing destructured `require("./xray-workflow")` near line 17)

**Interfaces:**
- Consumes: `SKIPPED_LOCAL_STATUS_LABELS`, `normalizeWorkflowStatus` (both in `xray-workflow.js`); `payload.passOnly` from Task 1.
- Produces: `localSkipLabel(status: string, passOnly: boolean): string` (empty string = do not skip); `validateWorkflowPayload(...)` result gains `passOnly: boolean`.

- [ ] **Step 1: Write the failing tests** (append to `workflow/xray-workflow.test.js`; `validateWorkflowPayload` is already imported there)

```js
test("localSkipLabel skips Fail only when passOnly is on", () => {
  assert.equal(localSkipLabel("pass", true), "");
  assert.equal(localSkipLabel("fail", false), "");
  assert.equal(localSkipLabel("fail", true), "Fail (Pass-only upload is on)");
  assert.equal(localSkipLabel("blocked", false), "Blocked");
  assert.equal(localSkipLabel("na", true), "N/A");
  assert.equal(localSkipLabel("notrun", false), "Not Run");
});

test("validateWorkflowPayload only enables passOnly for boolean true", () => {
  const base = {
    testExecutionSummary: "NS-15838 Test Execution",
    items: [
      {
        testcaseName: "Login flow",
        status: "fail",
        evidencePngDataUrl: "data:image/png;base64,AAAA",
      },
    ],
  };
  assert.equal(validateWorkflowPayload({ ...base }).passOnly, false);
  assert.equal(validateWorkflowPayload({ ...base, passOnly: "true" }).passOnly, false);
  assert.equal(validateWorkflowPayload({ ...base, passOnly: 1 }).passOnly, false);
  assert.equal(validateWorkflowPayload({ ...base, passOnly: true }).passOnly, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test workflow/xray-workflow.test.js`
Expected: FAIL (`localSkipLabel is not a function`; `passOnly` is `undefined`).

- [ ] **Step 3: Implement**

3a. `workflow/xray-workflow.js`, after `normalizeWorkflowStatus` (~line 152):

```js
// Returns the display label when a local status must not be uploaded, else "".
function localSkipLabel(status, passOnly) {
  if (Object.hasOwn(SKIPPED_LOCAL_STATUS_LABELS, status)) {
    return SKIPPED_LOCAL_STATUS_LABELS[status];
  }
  if (passOnly === true && status === "fail") return "Fail (Pass-only upload is on)";
  return "";
}
```

3b. Replace the loop's skip block (~lines 242-254). Old:

```js
    if (Object.hasOwn(SKIPPED_LOCAL_STATUS_LABELS, itemStatus)) {
      const message = `Skipped because local status is ${SKIPPED_LOCAL_STATUS_LABELS[itemStatus]}.`;
```

New:

```js
    const skipLabel = localSkipLabel(itemStatus, payload.passOnly);
    if (skipLabel) {
      const message = `Skipped because local status is ${skipLabel}.`;
```

(rest of the block is unchanged).

3c. Add `localSkipLabel,` to the `module.exports` object (~line 1447, keep alphabetical order).

3d. `workflow/server.js` `validateWorkflowPayload`: add `const passOnly = payload.passOnly === true;` after the `browserMode` line, and change the return to

```js
  return { testExecutionSummary, mode, browserMode, passOnly, items: normalizedItems };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test workflow/xray-workflow.test.js`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all PASS, including the Task 1 tests.

- [ ] **Step 6: Commit**

```bash
git add workflow/server.js workflow/xray-workflow.js workflow/xray-workflow.test.js
git commit -m "feat: skip Fail items in workflow when passOnly is set"
```

---

### Task 3: Version bump, docs and manual check

**Files:**
- Modify: `xray-md-evidence.html:2509`, `package.json:3`, `package-lock.json:3` and `:9`
- Modify: `README.md` (workflow/settings section near the other notes at ~line 160)

- [ ] **Step 0: Bump version 1.6.2 -> 1.6.3**

Change `const APP_VERSION = "1.6.2";` to `"1.6.3"` in `xray-md-evidence.html`, and `"version": "1.6.2"` to `"1.6.3"` at `package.json:3` and `package-lock.json:3` and `:9`. Then run `Grep` for `1\.6\.2` (excluding node_modules) to confirm no leftovers, and `npm test` to confirm no test pins the old version.

Commit: `git add xray-md-evidence.html package.json package-lock.json && git commit -m "chore: bump version to 1.6.3"`

- [ ] **Step 1: Document the setting.** Add one bullet next to the existing workflow notes:

```md
- **Upload Pass only** (Settings -> Xray Workflow, saved per workspace, off by default): when on, Fail test cases are skipped by Start Workflow and the all-evidence queue, the same way Blocked, N/A and Not Run already are. Unset test cases still upload as Pass.
```

- [ ] **Step 2: Commit only this hunk.** `README.md` already has an unrelated uncommitted edit (branch-cleanup snippet). Stage selectively:

```bash
git add -p README.md   # accept only the new bullet
git commit -m "docs: document Upload Pass only setting"
```

- [ ] **Step 3: Manual verification** (not automated; do not claim done without it)

Run `npm run evidence`, open Settings, tick **Upload Pass only**, save. Confirm: Fail card's Start Workflow is disabled, Pass card's is enabled, reload keeps the checkbox ticked. Untick, save, confirm Fail is enabled again. A live Xray run was not part of this plan and was not exercised by the tests.

---

### Task 4: Windows installer fixes

Context: users run `irm https://shikdershondhi.github.io/Xray-Evidence/install-windows.ps1 | iex`. The command itself is correct (live, returns a String in PowerShell 5.1 and 7). Two script problems found in review: (1) `exit` under `iex` closes the user's own terminal, hiding the error; (2) re-running deletes the install dir including `.xray-auth/jira-xray-auth-state.json`, the saved Jira login (treat as a credential). Out of scope: pinning to a tag/commit, Node version check, Pages-origin CORS (unverified).

**Security note:** this script is piped into `iex` on users' machines. A person must review the diff before merge. It only copies the existing auth folder locally; it never reads or prints its contents.

**Files:**
- Modify: `install-windows.ps1:14-44`
- Test: `tests/index-page.test.js` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new interfaces. The installed layout (`$InstallDir`, `start-server.bat`) is unchanged.

- [ ] **Step 1: Write the failing test** (append to `tests/index-page.test.js`; the `require`s are inside the test to avoid clashing with that file's existing names)

```js
test("install-windows.ps1 does not exit the caller's terminal and keeps the Jira session", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const script = fs.readFileSync(path.join(__dirname, "..", "install-windows.ps1"), "utf8");

  // `exit` under `irm | iex` would close the user's own PowerShell window.
  assert.doesNotMatch(script, /^\s*exit\b/m);
  assert.match(script, /^\s*return\b/m);

  // Re-install must carry the saved Jira session over.
  assert.match(script, /\.xray-auth/);
  assert.match(script, /Copy-Item[^\n]*\$AuthDir/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-name-pattern="install-windows.ps1" tests/index-page.test.js`
Expected: FAIL (bare `exit` lines present; no `.xray-auth` handling).

- [ ] **Step 3: Implement** in `install-windows.ps1`

3a. Node check (lines 15-19). Replace `exit 1` with `return`:

```powershell
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed." -ForegroundColor Red
  Write-Host "Install the LTS from https://nodejs.org then re-run this script."
  return
}
```

3b. Download block (lines 22-34). Replace with:

```powershell
Say "Downloading server bundle into $InstallDir"
$Tmp = Join-Path $env:TEMP ("xray-evidence-" + [guid]::NewGuid().ToString("N"))
$Zip = Join-Path $Tmp "repo.zip"
$AuthDir = Join-Path $InstallDir ".xray-auth"
$AuthBackup = Join-Path $Tmp "xray-auth-backup"
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.zip" `
    -OutFile $Zip -UseBasicParsing
  Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
  if (Test-Path $InstallDir) {
    # Keep the saved Jira/Xray login across re-installs (it lives in the install dir).
    if (Test-Path $AuthDir) { Copy-Item -Recurse -Path $AuthDir -Destination $AuthBackup }
    Remove-Item -Recurse -Force $InstallDir
  }
  Move-Item (Join-Path $Tmp "Xray-Evidence-$Branch") $InstallDir
  if (Test-Path $AuthBackup) {
    Copy-Item -Recurse -Path $AuthBackup -Destination $AuthDir
    Write-Host "Kept your saved Jira session."
  }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
```

(The restore is inside `try` because `$Tmp`, which holds the backup, is deleted in `finally`.)

3c. npm steps (lines 38-44). Replace both `if (...) { exit ... }` lines:

```powershell
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) {
  Write-Host "npm install failed (exit code $LASTEXITCODE)." -ForegroundColor Red
  return
}

Say "Installing Playwright Chromium browser"
npx playwright install chromium
if ($LASTEXITCODE -ne 0) {
  Write-Host "Playwright Chromium install failed (exit code $LASTEXITCODE)." -ForegroundColor Red
  return
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/index-page.test.js`
Expected: PASS (new test plus the existing install-command assertions).

- [ ] **Step 5: Manual verification** (the test only checks the script text; it does not run the installer)

In a scratch PowerShell window, run `powershell -NoProfile -File install-windows.ps1` once, create a dummy file `%USERPROFILE%\xray-evidence-server\.xray-auth\probe.txt` (no real session data), run the script again, and confirm `probe.txt` is still there. To check that errors no longer close the window, run `irm <local file URL or Get-Content> | iex` with `node` temporarily off `PATH` and confirm the window stays open with the red message. Delete `probe.txt` and the scratch install dir afterwards.

- [ ] **Step 6: Commit**

```bash
git add install-windows.ps1 tests/index-page.test.js
git commit -m "fix: keep Jira session and terminal open in Windows installer"
```

Note: `pages.yml` copies this file only on push to `main`, so the live `irm` URL keeps serving the old script until this branch is merged.

---

## Self-Review

- **Coverage:** setting + persistence (T1), frontend skip for single and queue (T1), payload field (T1/T2), server validation + skip (T2), version bump + docs (T3), installer fixes (T4). Fail-handling toggle covered; default-off covered by existing suite plus T1 step 1 assertion.
- **Placeholders:** none. One conditional note in T1 step 1 points to an existing adjacent test for the seeding guard, because that fixture's internals were not read.
- **Type consistency:** `passOnly` boolean everywhere; `isUploadSkippedForWorkflow(tc)` takes a test case (not a status) at all three call sites; `localSkipLabel(status, passOnly)` matches tests and loop usage.
- **Review Focus:** legacy/no-key (`=== true`), import/export (`normalizeWorkflowSettings`), non-boolean server input (T2 test), toggle locked during a running queue (T1 3l/3m). All-Fail queue intentionally left to the user (existing empty-queue toast).
- **Known assumption:** `workspace.workflow` is created on first save, so the toggle needs a saved Test Execution Summary only for actually starting a run (existing guard), not for saving the checkbox.
