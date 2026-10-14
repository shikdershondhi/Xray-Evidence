# Blocked Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third execution status, `Blocked`, next to Pass/Fail in the evidence tool, and make it a TC filter option. Blocked TCs are never uploaded by the Xray workflow.

**Architecture:** Status is a string on each test case (`pass` | `fail` | `unset`), normalized by `normalizeStatus` in `xray-md-evidence.html`. Add `blocked` to that set, then add a checkbox in the execution panel, a filter option, and styling. Workflow layer (`workflow/xray-workflow.js`) keeps `blocked` instead of coercing it to `pass`, and skips blocked items. Frontend also excludes blocked TCs from the upload queue (defense in depth).

**Tech Stack:** Single-file vanilla JS/HTML (`xray-md-evidence.html`), Node `http` server, Playwright, Node built-in test runner (`node --test`).

**Spec:** Conversation 2026-10-14. User asked: "add a new option Blocked beside pass fail, add this option as filter as well". Decisions: Blocked TCs are skipped by the Xray workflow (no Xray status change); no "Report Bug" button for Blocked.

## Global Constraints

- `xray-md-evidence.html` stays one self-contained file: no external scripts/CSS, no build step.
- Plain CommonJS on the Node side; no TypeScript.
- Product name is spelled `NeuString` (capital S) in any UI/docs copy.
- Tests are Node built-in runner: `node --test <file>`. Browser tests need `npm run setup` already run.
- Filters are AND-combined (`matchesEvidenceFilter` uses `every`). Blocked follows the same rule; do not change that.
- Status checkboxes are mutually exclusive by re-render: `updateStatus` sets `tc.status` to the clicked status, or `unset` when unchecked. Keep that mechanism.
- Stored `tc.status` of `"blocked"` must round-trip through localStorage, gist sync, and markdown/HTML export (all already go through `normalizeStatus`).

## File Structure

- Modify `xray-md-evidence.html`: CSS vars + `.status-option.blocked`; filter menu option; `updateTcFilterUi` labels; `executionHtml` checkbox; `normalizeStatus`; `matchesEvidenceFilter`; workflow start guards.
- Modify `workflow/xray-workflow.js`: `normalizeWorkflowStatus` keeps `blocked`; main loop skips blocked items.
- Modify `tests/xray-md-evidence.test.js`: filter test + status toggle test + workflow exclusion test.
- Modify `workflow/xray-workflow.test.js`: status normalization test.

---

### Task 1: Blocked status control and filter (frontend)

**Files:**
- Modify: `xray-md-evidence.html` (CSS ~line 36-44 and ~86-88 for vars, ~1464 for class; filter menu ~1857-1862; `updateTcFilterUi` ~3566-3573; `executionHtml` ~3750-3753; `matchesEvidenceFilter` ~6343-6344; `normalizeStatus` ~6353-6356)
- Test: `tests/xray-md-evidence.test.js` (append after the test ending at line 349)

**Interfaces:**
- Consumes: existing `normalizeStatus(value)`, `updateStatus(tcId, status, checked)`, `activeTcFilters` Set, `testCaseFixture`, `workspaceWithUploadedCases`, `seedWorkspace`, `readStoredState`, `htmlUrl` (test helpers at top of test file).
- Produces: `normalizeStatus` returns one of `"pass" | "fail" | "blocked" | "unset"`. Filter value `"blocked"`. Checkbox `input[data-action="status"][data-status="blocked"]`. CSS class `.status-option.blocked`.

- [ ] **Step 1: Write the failing test**

Append to `tests/xray-md-evidence.test.js`:

```js
test("blocked status can be set, persists, hides Report Bug, and filters cards", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Login flow", status: "pass" }),
        testCaseFixture({ id: "TC-002", title: "Upload evidence", status: "fail" }),
        testCaseFixture({ id: "TC-003", title: "Logout flow", status: "unset" }),
      ]),
    );

    await page.goto(htmlUrl);
    await page.waitForSelector("article.tc-card");

    // Set TC-003 to blocked; it replaces any other status.
    await page
      .locator('input[data-action="status"][data-status="blocked"][data-tc="TC-003"]')
      .check();
    let state = await readStoredState(page);
    assert.equal(
      state.workspaces[0].testCases.find((tc) => tc.id === "TC-003").status,
      "blocked",
    );
    assert.equal(
      await page
        .locator('input[data-action="status"][data-status="pass"][data-tc="TC-003"]')
        .isChecked(),
      false,
    );
    // Report Bug stays Fail-only.
    assert.equal(
      await page.locator('button[data-action="report-bug"][data-tc="TC-003"]').count(),
      0,
    );

    // Switching TC-002 from fail to blocked removes its Report Bug button.
    await page
      .locator('input[data-action="status"][data-status="blocked"][data-tc="TC-002"]')
      .check();
    assert.equal(
      await page.locator('button[data-action="report-bug"][data-tc="TC-002"]').count(),
      0,
    );

    // Filter.
    await page.locator("#evidenceFilterBtn").click();
    await page.locator('#evidenceFilterMenu input[value="blocked"]').check();
    assert.equal(await page.locator("article.tc-card").count(), 2);
    assert.equal(await page.locator("#tcFilterCount").textContent(), "2 / 3 TCs");
    assert.equal(await page.locator("#evidenceFilterLabel").textContent(), "Blocked");

    // Unchecking reverts to unset (existing behavior for pass/fail).
    await page.locator("#clearFiltersBtn").click();
    await page
      .locator('input[data-action="status"][data-status="blocked"][data-tc="TC-003"]')
      .uncheck();
    state = await readStoredState(page);
    assert.equal(
      state.workspaces[0].testCases.find((tc) => tc.id === "TC-003").status,
      "unset",
    );
  } finally {
    await browser.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="blocked status can be set" tests/xray-md-evidence.test.js`
Expected: FAIL (locator for `data-status="blocked"` times out; checkbox does not exist).

- [ ] **Step 3: Add CSS variables and class**

In the light `:root` block, after `--fail-line: #f0a0a0;` (line 38) add:

```css
        --blocked-bg: #f4f0ff;
        --blocked-ink: #4c1d95;
        --blocked-line: #c4b5fd;
```

In `body[data-theme="dark"]`, after `--fail-line: #944450;` (line 82) add:

```css
        --blocked-bg: #2b1f4a;
        --blocked-ink: #ddd0ff;
        --blocked-line: #6d54b0;
```

After the `.status-option.fail { ... }` rule (ends ~line 1462) add:

```css
      .status-option.blocked {
        border-color: var(--blocked-line);
        background: var(--blocked-bg);
        color: var(--blocked-ink);
      }
```

- [ ] **Step 4: Add the status checkbox**

In `executionHtml`, directly after the Fail `</label>` (ends at line ~3753) and before the `status-option uploaded` label, insert:

```js
            <label class="status-option blocked">
              <input type="checkbox" data-action="status" data-status="blocked" data-tc="${tc.id}" ${status === "blocked" ? "checked" : ""}>
              Blocked
            </label>
```

- [ ] **Step 5: Update `normalizeStatus`**

Replace:

```js
          return ["pass", "fail"].includes(normalized) ? normalized : "unset";
```

with:

```js
          return ["pass", "fail", "blocked"].includes(normalized) ? normalized : "unset";
```

- [ ] **Step 6: Add the filter option and logic**

In the filter menu, after the "Status: Fail" label (ends line ~1862) add:

```html
              <label class="tc-filter-option"
                ><input type="checkbox" value="blocked" /> Status: Blocked</label
              >
```

In `updateTcFilterUi` labels object add `blocked: "Blocked",` after `fail: "Fail",`.

In `matchesEvidenceFilter` add after the `fail` line:

```js
            if (filter === "blocked") return normalizeStatus(tc.status) === "blocked";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test tests/xray-md-evidence.test.js`
Expected: PASS, including existing `filter supports multiple options...` test (label still `Pass + Fail`).

- [ ] **Step 8: Commit**

```bash
git add xray-md-evidence.html tests/xray-md-evidence.test.js
git commit -m "feat: add Blocked execution status and filter"
```

---

### Task 2: Keep Blocked TCs out of Xray uploads

**Files:**
- Modify: `workflow/xray-workflow.js:140-143` (`normalizeWorkflowStatus`), `:230-232` (loop head)
- Modify: `xray-md-evidence.html` (`startXrayWorkflowForTc` ~4352, `startXrayWorkflowForWorkspace` ~4358-4362, `workflowDisabled` ~3711)
- Test: `workflow/xray-workflow.test.js` (extend test at line 27), `tests/xray-md-evidence.test.js` (append)

**Interfaces:**
- Consumes: `normalizeStatus` from Task 1 (returns `"blocked"`), `toast(message)` helper already used in `startXrayWorkflowForWorkspace`.
- Produces: `normalizeWorkflowStatus("blocked") === "blocked"`; workflow result items `{ testcaseName, status: "skipped", localStatus: "blocked", message }`.

- [ ] **Step 1: Write the failing server-side test**

In `workflow/xray-workflow.test.js`, inside `test("normalizes workflow item statuses", ...)` add before the closing `});`:

```js
  assert.equal(normalizeWorkflowStatus("blocked"), "blocked");
  assert.equal(normalizeWorkflowStatus("BLOCKED"), "blocked");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern="normalizes workflow item statuses" workflow/xray-workflow.test.js`
Expected: FAIL: `'pass' !== 'blocked'`.

- [ ] **Step 3: Implement `normalizeWorkflowStatus`**

Replace the function in `workflow/xray-workflow.js`:

```js
function normalizeWorkflowStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "fail") return "fail";
  if (normalized === "blocked") return "blocked";
  return "pass";
}
```

`setExecutionStatus` and `requireExecutionStatus` are only reached for non-blocked items after Step 4, so they need no change.

- [ ] **Step 4: Skip blocked items in the workflow loop**

In `runXrayWorkflow`, directly after `throwIfWorkflowCancelled(options.signal);` at the top of the `for (const [index, item] of payload.items.entries())` loop (line ~231) and before `let currentStep`, insert:

```js
    if (normalizeWorkflowStatus(item.status) === "blocked") {
      const message = "Skipped because local status is Blocked.";
      notifyLog(notify, "warn", item.testcaseName, message);
      const blockedResult = {
        testcaseName: item.testcaseName,
        status: "skipped",
        localStatus: "blocked",
        message,
      };
      results.push(blockedResult);
      options.onResult?.(blockedResult);
      continue;
    }
```

Note: the `index > 0` branch navigates back to the executions page using the loop index, so a skipped item causes at most one redundant reload for the next item. Accepted; behavior stays correct.

- [ ] **Step 5: Run server-side tests**

Run: `node --test workflow/xray-workflow.test.js`
Expected: PASS (existing "anything else" -> `pass` assertions still hold).

- [ ] **Step 6: Write the failing frontend test**

Append to `tests/xray-md-evidence.test.js`:

```js
test("blocked test cases cannot start the Xray workflow", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Login flow", status: "blocked" }),
        testCaseFixture({ id: "TC-002", title: "Upload evidence", status: "pass" }),
      ]),
    );
    await stubWorkflowService(page);

    await page.goto(htmlUrl);
    await page.waitForSelector("article.tc-card");
    assert.equal(
      await page
        .locator('button[data-action="start-workflow"][data-tc="TC-001"]')
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .locator('button[data-action="start-workflow"][data-tc="TC-002"]')
        .isDisabled(),
      false,
    );
  } finally {
    await browser.close();
  }
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `node --test --test-name-pattern="blocked test cases cannot start" tests/xray-md-evidence.test.js`
Expected: FAIL (TC-001 button is enabled).

- [ ] **Step 8: Implement frontend guards**

a) `workflowDisabled` (line ~3711): replace

```js
          const workflowDisabled = noEvidence || workflowState.queueActive;
```

with

```js
          const workflowDisabled =
            noEvidence ||
            workflowState.queueActive ||
            normalizeStatus(tc.status) === "blocked";
```

b) `startXrayWorkflowForTc`: after the `if (!tc) throw ...` line add:

```js
          if (normalizeStatus(tc.status) === "blocked") {
            toast("Blocked test cases are not uploaded to Xray.");
            return;
          }
```

c) `startXrayWorkflowForWorkspace`: change the items filter to

```js
          const items =
            workspace?.testCases.filter(
              (tc) =>
                tc.images.length &&
                !tc.xrayUploaded &&
                normalizeStatus(tc.status) !== "blocked",
            ) || [];
```

`workflowStatusForUpload` needs no change (`blocked` never reaches it).

- [ ] **Step 9: Run full suite**

Run: `npm test`
Expected: all PASS (browser tests need Chromium from `npm run setup`).

- [ ] **Step 10: Commit**

```bash
git add workflow/xray-workflow.js workflow/xray-workflow.test.js xray-md-evidence.html tests/xray-md-evidence.test.js
git commit -m "feat: skip Blocked test cases in Xray workflow"
```

---

## Self-Review

- **Spec coverage:** "Blocked beside pass fail" → Task 1 Steps 3-5. "Add as filter" → Task 1 Step 6. Skip in Xray (user decision) → Task 2 (server skip, button disabled, queue exclusion). No Report Bug (user decision) → `status === "fail"` condition unchanged, asserted in Task 1 test.
- **Placeholders:** none.
- **Type consistency:** status string `"blocked"` used identically in `normalizeStatus`, filter value, `data-status`, `normalizeWorkflowStatus`, and result `localStatus`.

## Risks / Review Flags

- Exports (markdown ~line 5295, HTML ~5379) and gist save (~6283) print `normalizeStatus(tc.status)`; they emit `blocked` automatically. Older readers treat unknown values as `unset`; no migration needed. Verify with one manual export.
- Not verified: how Xray itself names/handles a Blocked status. Plan avoids it by not touching Xray status.
- Workflow file change is automation code; have a human review the loop-skip change before merge.
