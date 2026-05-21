const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("@playwright/test");

const evidenceHtml = readFileSync(
  path.resolve(__dirname, "..", "xray-md-evidence.html"),
  "utf8",
);
const htmlUrl = pathToFileURL(
  path.resolve(__dirname, "..", "xray-md-evidence.html"),
).href;

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function workspaceWithUploadedCases(testCases) {
  return {
    activeWorkspaceId: "ws-1",
    workspaces: [
      {
        id: "ws-1",
        name: "Evidence Workspace",
        sourceName: "source.md",
        sourceType: "markdown",
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
        workflow: {
          testExecutionSummary: "NS-1 Test Execution",
          browserMode: "headless",
          savedAt: "2026-05-19T00:00:00.000Z",
        },
        testCases,
      },
    ],
  };
}

function testCaseFixture(overrides = {}) {
  return {
    id: "TC-001",
    title: "Upload evidence",
    summary: "",
    relatedAc: "",
    precondition: "",
    steps: [],
    expectedResult: "",
    actualResult: "Upload completed successfully.",
    status: "pass",
    sourceLine: 12,
    images: [
      {
        id: "img-1",
        dataUrl: onePixelPng,
        note: "First screen is the upload form.",
        createdAt: "2026-05-19T00:01:00.000Z",
      },
    ],
    ...overrides,
  };
}

async function seedWorkspace(page, workspace) {
  await page.addInitScript((payload) => {
    if (!localStorage.getItem("neustring-xray-md-evidence-builder-v1")) {
      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1",
        JSON.stringify(payload),
      );
    }
  }, workspace);
}

async function readStoredState(page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("neustring-xray-md-evidence-builder-v1")),
  );
}

async function readStoredImageKeys(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(
          "neustring-xray-md-evidence-builder-v1-images",
          1,
        );
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("screenshots", "readonly");
          const store = tx.objectStore("screenshots");
          const keysRequest = store.getAllKeys();
          keysRequest.onerror = () => reject(keysRequest.error);
          keysRequest.onsuccess = () => resolve(keysRequest.result.sort());
        };
      }),
  );
}

test("embedded user manual documents uploaded evidence cleanup", () => {
  assert.match(evidenceHtml, /clear evidence files/i);
  assert.match(evidenceHtml, /Uploaded in Xray/);
  assert.match(evidenceHtml, /active workspace/i);
  assert.match(evidenceHtml, /browser storage/i);
  assert.match(evidenceHtml, /TC details, status, Actual Result/i);
});

test("copy seperatly writes all screenshots as separate clipboard items at once", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript((workspace) => {
      class ClipboardItemStub {
        constructor(items) {
          this.items = items;
        }
      }

      Object.defineProperty(window, "ClipboardItem", {
        value: ClipboardItemStub,
        configurable: true,
      });

      Object.defineProperty(navigator, "clipboard", {
        value: {
          async write(items) {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push(items);
          },
        },
        configurable: true,
      });

      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1",
        JSON.stringify(workspace),
      );
    }, {
      activeWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Evidence Workspace",
          sourceName: "source.md",
          sourceType: "markdown",
          createdAt: "2026-05-19T00:00:00.000Z",
          updatedAt: "2026-05-19T00:00:00.000Z",
          testCases: [
            {
              id: "TC-002",
              title: "Upload evidence",
              summary: "",
              relatedAc: "",
              precondition: "",
              steps: [],
              expectedResult: "",
              actualResult: "Upload completed successfully.",
              status: "pass",
              sourceLine: 12,
              images: [
                {
                  id: "img-1",
                  dataUrl: onePixelPng,
                  note: "First screen is the upload form.",
                  createdAt: "2026-05-19T00:01:00.000Z",
                },
                {
                  id: "img-2",
                  dataUrl: onePixelPng,
                  note: "",
                  createdAt: "2026-05-19T00:02:00.000Z",
                },
                {
                  id: "img-3",
                  dataUrl: onePixelPng,
                  note: "Confirmation message is visible.",
                  createdAt: "2026-05-19T00:03:00.000Z",
                },
              ],
            },
          ],
        },
      ],
    });

    await page.goto(htmlUrl);
    const copySeparately = page.locator(
      'button[data-action="copy-separately"][data-tc="TC-002"]',
    );

    await copySeparately.click();
    await page.waitForFunction(() => window.__clipboardWrites?.length === 1);

    const payload = await page.evaluate(async () => {
      const items = window.__clipboardWrites[0];
      const imageTypes = items.map((item) => Object.keys(item.items));
      const firstImageText = await items[0].items["text/plain"].text();
      const secondImageText = items[1].items["text/plain"]
        ? await items[1].items["text/plain"].text()
        : "";
      const thirdImageText = await items[2].items["text/plain"].text();

      return {
        imageTypes,
        firstImageText,
        secondImageText,
        thirdImageText,
      };
    });

    assert.equal(payload.imageTypes.length, 3);
    assert.deepEqual(
      payload.imageTypes.map((types) => types.sort()),
      [
        ["image/png", "text/plain"],
        ["image/png"],
        ["image/png", "text/plain"],
      ],
    );
    assert.match(
      payload.firstImageText,
      /Actual Result:\nUpload completed successfully\./,
    );
    assert.match(
      payload.firstImageText,
      /Note 1:\nFirst screen is the upload form\./,
    );
    assert.equal(payload.secondImageText, "");
    assert.match(
      payload.thirdImageText,
      /Note 3:\nConfirmation message is visible\./,
    );
  } finally {
    await browser.close();
  }
});

test("uploaded in Xray checkbox defaults unchecked, persists, and filters cards", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Not uploaded evidence" }),
        testCaseFixture({
          id: "TC-002",
          title: "Already uploaded evidence",
          xrayUploaded: true,
        }),
      ]),
    );

    await page.goto(htmlUrl);

    const notUploaded = page.locator(
      'input[data-action="xray-uploaded"][data-tc="TC-001"]',
    );
    const uploaded = page.locator(
      'input[data-action="xray-uploaded"][data-tc="TC-002"]',
    );
    await assert.equal(await notUploaded.isChecked(), false);
    await assert.equal(await uploaded.isChecked(), true);

    await notUploaded.check();
    await page.reload();
    await assert.equal(
      await page
        .locator('input[data-action="xray-uploaded"][data-tc="TC-001"]')
        .isChecked(),
      true,
    );

    await page.locator("#evidenceFilter").selectOption("uploaded");
    await assert.equal(await page.locator('article[data-tc="TC-001"]').count(), 1);
    await assert.equal(await page.locator('article[data-tc="TC-002"]').count(), 1);

    await page.locator("#evidenceFilter").selectOption("all");
    await page
      .locator('input[data-action="xray-uploaded"][data-tc="TC-001"]')
      .uncheck();
    await page.locator("#evidenceFilter").selectOption("not-uploaded");
    await assert.equal(await page.locator('article[data-tc="TC-001"]').count(), 1);
    await assert.equal(await page.locator('article[data-tc="TC-002"]').count(), 0);
  } finally {
    await browser.close();
  }
});

test("testcase Save pushes to Gist without confirmation", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let confirmCalls = 0;
  let gistPatchCount = 0;

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Upload evidence" }),
      ]),
    );
    await page.addInitScript(() => {
      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1-gist",
        JSON.stringify({
          username: "octocat",
          token: "token-1",
          gistId: "gist-1",
        }),
      );
      window.confirm = () => {
        window.__confirmCalls = (window.__confirmCalls || 0) + 1;
        return true;
      };
    });
    await page.route("https://api.github.com/gists/gist-1", async (route) => {
      if (route.request().method() === "PATCH") {
        gistPatchCount += 1;
        await route.fulfill({ json: { id: "gist-1" } });
        return;
      }
      await route.fallback();
    });

    await page.goto(htmlUrl);
    const saveButton = page.locator(
      'button[data-action="save-to-gist"][data-tc="TC-001"]',
    );
    await assert.doesNotReject(saveButton.waitFor());
    const copySeparatelyBox = await page
      .locator('button[data-action="copy-separately"][data-tc="TC-001"]')
      .boundingBox();
    const saveBox = await saveButton.boundingBox();
    assert.ok(copySeparatelyBox);
    assert.ok(saveBox);
    assert.ok(saveBox.width >= copySeparatelyBox.width);
    assert.ok(saveBox.height >= copySeparatelyBox.height);
    await saveButton.click();
    await page.locator(".toast", { hasText: "Pushed 1 workspace(s) to Gist" }).waitFor();

    confirmCalls = await page.evaluate(() => window.__confirmCalls || 0);
    assert.equal(confirmCalls, 0);
    assert.equal(gistPatchCount, 1);
  } finally {
    await browser.close();
  }
});

test("settings Push to Gist keeps the existing confirmation", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let gistPatchCount = 0;

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Upload evidence" }),
      ]),
    );
    await page.addInitScript(() => {
      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1-gist",
        JSON.stringify({
          username: "octocat",
          token: "token-1",
          gistId: "gist-1",
        }),
      );
      window.__confirmCalls = 0;
      window.confirm = () => {
        window.__confirmCalls += 1;
        return true;
      };
    });
    await page.route("https://api.github.com/gists/gist-1", async (route) => {
      if (route.request().method() === "PATCH") {
        gistPatchCount += 1;
        await route.fulfill({ json: { id: "gist-1" } });
        return;
      }
      await route.fallback();
    });

    await page.goto(htmlUrl);
    await page.locator("#settingsDrawerOpenBtn").click();
    await page.locator("#pushGistBtn").click();
    await page.locator(".toast", { hasText: "Pushed 1 workspace(s) to Gist" }).waitFor();

    assert.equal(await page.evaluate(() => window.__confirmCalls), 1);
    assert.equal(gistPatchCount, 1);
  } finally {
    await browser.close();
  }
});

test("saved Gist settings do not start automatic sync on load or save", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let gistGetCount = 0;

  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1-gist",
        JSON.stringify({
          username: "octocat",
          token: "token-1",
          gistId: "gist-1",
        }),
      );
      window.__gistAutoSyncTimerCount = 0;
      window.setInterval = (handler, timeout, ...args) => {
        window.__gistAutoSyncTimerCount += 1;
        if (typeof handler === "function") handler(...args);
        return 1;
      };
      window.clearInterval = () => {};
    });
    await page.route("https://api.github.com/gists/gist-1", async (route) => {
      if (route.request().method() === "GET") {
        gistGetCount += 1;
        await route.fulfill({
          json: {
            id: "gist-1",
            files: {
              "workspaces.json": {
                content: JSON.stringify({ workspaces: [] }),
              },
            },
          },
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(htmlUrl);
    await page.locator("#settingsDrawerOpenBtn").click();
    await page.locator("#saveGistBtn").click();
    await page.waitForTimeout(100);

    assert.equal(
      await page.evaluate(() => window.__gistAutoSyncTimerCount),
      0,
    );
    assert.equal(gistGetCount, 0);
  } finally {
    await browser.close();
  }
});

test("workflow result marks uploaded only after a successful matching result", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let runId = "run-success";

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Upload evidence" }),
      ]),
    );
    await page.route("http://127.0.0.1:39291/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/health") {
        await route.fulfill({ json: { status: "ready" } });
        return;
      }
      if (url.pathname === "/workflow/start") {
        await route.fulfill({
          json: { runId, status: "queued", message: "Workflow queued." },
        });
        return;
      }
      await route.fulfill({
        json: {
          runId,
          status: runId === "run-success" ? "success" : "failed",
          message: "Workflow finished.",
          payloadSummary: { itemCount: 1, browserMode: "headless" },
          logs: [],
          results: [
            {
              testcaseName: "Upload evidence",
              status: runId === "run-success" ? "success" : "failed",
            },
          ],
        },
      });
    });

    await page.goto(htmlUrl);
    await page
      .locator('button[data-action="start-workflow"][data-tc="TC-001"]')
      .click();
    await assert.doesNotReject(
      page
        .locator('input[data-action="xray-uploaded"][data-tc="TC-001"]')
        .waitFor({ state: "attached" }),
    );
    await page.waitForFunction(() =>
      document.querySelector('input[data-action="xray-uploaded"][data-tc="TC-001"]')
        ?.checked,
    );

    await page
      .locator('input[data-action="xray-uploaded"][data-tc="TC-001"]')
      .uncheck();
    runId = "run-failed";
    await page
      .locator('button[data-action="start-workflow"][data-tc="TC-001"]')
      .click();
    await page.locator(".workflow-run-title", { hasText: "Workflow failed" }).waitFor();
    await assert.equal(
      await page
        .locator('input[data-action="xray-uploaded"][data-tc="TC-001"]')
        .isChecked(),
      false,
    );
  } finally {
    await browser.close();
  }
});

test("workflow result marks failed local testcase uploaded when matching item upload succeeds", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({
          id: "TC-001",
          title: "Failed evidence with uploaded result",
          status: "fail",
          xrayUploaded: false,
        }),
      ]),
    );
    await page.route("http://127.0.0.1:39291/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/health") {
        await route.fulfill({ json: { status: "ready" } });
        return;
      }
      if (url.pathname === "/workflow/start") {
        await route.fulfill({
          json: { runId: "run-partial", status: "queued", message: "Workflow queued." },
        });
        return;
      }
      await route.fulfill({
        json: {
          runId: "run-partial",
          status: "partial",
          message: "Workflow finished with failures.",
          payloadSummary: { itemCount: 2, browserMode: "headless" },
          logs: [],
          results: [
            {
              testcaseName: "Failed evidence with uploaded result",
              localStatus: "fail",
              status: "success",
            },
            {
              testcaseName: "Another testcase",
              localStatus: "pass",
              status: "failed",
            },
          ],
        },
      });
    });

    await page.goto(htmlUrl);
    await page
      .locator('button[data-action="start-workflow"][data-tc="TC-001"]')
      .click();
    await page.waitForFunction(() =>
      document.querySelector('input[data-action="xray-uploaded"][data-tc="TC-001"]')
        ?.checked,
    );

    await assert.equal(
      await page
        .locator('input[data-action="xray-uploaded"][data-tc="TC-001"]')
        .isChecked(),
      true,
    );
  } finally {
    await browser.close();
  }
});

test("saving workflow settings refreshes visible values and marks workspace modified", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const workspace = workspaceWithUploadedCases([
      testCaseFixture({ id: "TC-001", title: "Upload evidence" }),
    ]);
    workspace.workspaces[0].remoteStatus = "synced";
    workspace.workspaces[0].remoteSyncedAt = "2026-05-19T00:02:00.000Z";
    await seedWorkspace(page, workspace);

    await page.goto(htmlUrl);
    await page.locator("#settingsDrawerOpenBtn").click();
    await page.locator("#workflowSummarySetting").fill("NS-2 Updated Execution");
    await page
      .locator('input[name="workflowBrowserModeSetting"][value="headed"]')
      .check();
    await page.locator("#saveWorkflowSettingsBtn").click();

    await assert.doesNotReject(
      page.getByText("NS-2 Updated Execution").waitFor(),
    );
    await assert.doesNotReject(
      page
        .locator(".project-item.active .sync-chip", { hasText: "Modified" })
        .waitFor(),
    );
    await assert.equal(
      await page
        .locator('[data-workflow-panel="TC-001"] .workflow-mode-options')
        .textContent(),
      "Browser mode: headed",
    );
  } finally {
    await browser.close();
  }
});

test("testcase Cancel Workflow cancels the active run", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let cancelCount = 0;

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "Upload evidence" }),
      ]),
    );
    await page.route("http://127.0.0.1:39291/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/health") {
        await route.fulfill({ json: { status: "ready" } });
        return;
      }
      if (url.pathname === "/workflow/start") {
        await route.fulfill({
          json: { runId: "run-cancel", status: "queued", message: "Workflow queued." },
        });
        return;
      }
      if (url.pathname === "/workflow/run-cancel/cancel") {
        cancelCount += 1;
        await route.fulfill({
          json: {
            runId: "run-cancel",
            status: "cancelled",
            message: "Workflow cancelled.",
            payloadSummary: { itemCount: 1, browserMode: "headless" },
            logs: [{ time: new Date().toISOString(), level: "warn", message: "Workflow cancelled." }],
            results: [],
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          runId: "run-cancel",
          status: "running",
          message: "Workflow running.",
          payloadSummary: { itemCount: 1, browserMode: "headless" },
          logs: [],
          results: [],
        },
      });
    });

    await page.goto(htmlUrl);
    await page
      .locator('button[data-action="start-workflow"][data-tc="TC-001"]')
      .click();
    const cancelButton = page.locator(
      'button[data-action="cancel-workflow"][data-tc="TC-001"]',
    );
    await cancelButton.waitFor();
    await cancelButton.click();
    await page.locator(".workflow-run-title", { hasText: "Workflow cancelled" }).waitFor();

    assert.equal(cancelCount, 1);
  } finally {
    await browser.close();
  }
});

test("workbench Cancel Workflow stops the queue before starting the next testcase", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let startCount = 0;
  let cancelCount = 0;
  let cancelled = false;

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "First evidence" }),
        testCaseFixture({ id: "TC-002", title: "Second evidence" }),
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
        startCount += 1;
        await route.fulfill({
          json: { runId: "run-queue", status: "queued", message: "Workflow queued." },
        });
        return;
      }
      if (url.pathname === "/workflow/run-queue/cancel") {
        cancelCount += 1;
        cancelled = true;
        await route.fulfill({
          json: {
            runId: "run-queue",
            status: "cancelled",
            message: "Workflow cancelled.",
            payloadSummary: { itemCount: 1, browserMode: "headless" },
            logs: [{ time: new Date().toISOString(), level: "warn", message: "Workflow cancelled." }],
            results: [],
          },
        });
        return;
      }
      if (cancelled) {
        await route.fulfill({
          json: {
            runId: "run-queue",
            status: "cancelled",
            message: "Workflow cancelled.",
            payloadSummary: { itemCount: 1, browserMode: "headless" },
            logs: [{ time: new Date().toISOString(), level: "warn", message: "Workflow cancelled." }],
            results: [],
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          runId: "run-queue",
          status: "running",
          message: "Workflow running.",
          payloadSummary: { itemCount: 1, browserMode: "headless" },
          logs: [],
          results: [],
        },
      });
    });

    await page.goto(htmlUrl);
    await page.locator("#startWorkspaceWorkflowBtn").click();
    await page.waitForFunction(() => !document.querySelector("#cancelWorkspaceWorkflowBtn")?.disabled);
    await page.locator("#cancelWorkspaceWorkflowBtn").click();
    await page.locator(".toast", { hasText: "Workflow queue cancelled" }).waitFor();

    assert.equal(cancelCount, 1);
    assert.equal(startCount, 1);
  } finally {
    await browser.close();
  }
});

test("workbench workflow panel shows all-evidence queue progress and logs", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let cancelCount = 0;
  let cancelled = false;

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({ id: "TC-001", title: "First evidence" }),
        testCaseFixture({ id: "TC-002", title: "Second evidence" }),
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
          json: { runId: "run-workbench", status: "queued", message: "Workflow queued." },
        });
        return;
      }
      if (url.pathname === "/workflow/run-workbench/cancel") {
        cancelCount += 1;
        cancelled = true;
        await route.fulfill({
          json: {
            runId: "run-workbench",
            status: "cancelled",
            message: "Workflow cancelled.",
            payloadSummary: { itemCount: 1, browserMode: "headless" },
            logs: [
              {
                time: "2026-05-19T00:03:00.000Z",
                level: "warn",
                testcaseName: "First evidence",
                message: "Workflow cancelled.",
              },
            ],
            results: [],
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          runId: "run-workbench",
          status: cancelled ? "cancelled" : "running",
          message: cancelled ? "Workflow cancelled." : "Uploading evidence in Playwright.",
          payloadSummary: { itemCount: 1, browserMode: "headless" },
          logs: [
            {
              time: "2026-05-19T00:02:00.000Z",
              level: "info",
              testcaseName: "First evidence",
              message: "Opened Playwright page.",
            },
          ],
          results: [],
        },
      });
    });

    await page.goto(htmlUrl);
    await page.locator("#startWorkspaceWorkflowBtn").click();

    const panel = page.locator("#workspaceWorkflowPanel");
    await panel.waitFor();
    await assert.doesNotReject(
      panel.getByText("Uploading 1 of 2: First evidence").waitFor(),
    );
    await assert.doesNotReject(
      panel
        .locator(".workspace-workflow-latest", {
          hasText: "Opened Playwright page.",
        })
        .waitFor(),
    );
    await assert.doesNotReject(panel.getByText("info").waitFor());
    await assert.doesNotReject(
      panel
        .locator(".workspace-workflow-log", { hasText: "First evidence" })
        .waitFor(),
    );

    await page.locator("#cancelWorkspaceWorkflowBtn").click();
    await page.locator(".toast", { hasText: "Workflow queue cancelled" }).waitFor();
    await panel.getByText("cancelled").waitFor();

    assert.equal(cancelCount, 1);
  } finally {
    await browser.close();
  }
});

test("workbench workflow skips testcases already uploaded in Xray", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let startCount = 0;
  let requestItems = [];

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({
          id: "TC-001",
          title: "Already uploaded evidence",
          xrayUploaded: true,
        }),
        testCaseFixture({
          id: "TC-002",
          title: "Pending evidence",
          xrayUploaded: false,
        }),
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
        startCount += 1;
        const body = JSON.parse(route.request().postData() || "{}");
        requestItems = body.items || [];
        await route.fulfill({
          json: { runId: "run-skip-uploaded", status: "queued", message: "Workflow queued." },
        });
        return;
      }
      await route.fulfill({
        json: {
          runId: "run-skip-uploaded",
          status: "success",
          message: "Workflow finished.",
          payloadSummary: { itemCount: 1, browserMode: "headless" },
          logs: [],
          results: [
            {
              testcaseName: "Pending evidence",
              status: "success",
            },
          ],
        },
      });
    });

    await page.goto(htmlUrl);
    await page.locator("#startWorkspaceWorkflowBtn").click();
    await page.locator(".toast", { hasText: "Workflow queue completed" }).waitFor();

    assert.equal(startCount, 1);
    assert.deepEqual(
      requestItems.map((item) => item.testcaseName),
      ["Pending evidence"],
    );
  } finally {
    await browser.close();
  }
});

test("actual result and screenshot notes render markdown previews safely", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({
          id: "TC-001",
          actualResult:
            "**Upload completed**\n\n- Form submitted\n\n| Field | Value |\n| --- | --- |\n| Status | Pass |\n\n<script>window.__markdownUnsafe = true</script>",
          images: [
            {
              id: "img-1",
              dataUrl: onePixelPng,
              note: "### Note heading\n\n1. Open form\n2. Submit `evidence`",
              createdAt: "2026-05-19T00:01:00.000Z",
            },
          ],
        }),
      ]),
    );

    await page.goto(htmlUrl);

    const actualPreview = page.locator(
      '[data-markdown-preview="actual-result"][data-tc="TC-001"]',
    );
    await assert.doesNotReject(actualPreview.locator("strong").waitFor());
    await assert.equal(await actualPreview.locator("table").count(), 1);
    await assert.equal(await actualPreview.locator("li").count(), 1);
    await assert.equal(await page.evaluate(() => window.__markdownUnsafe), undefined);
    assert.match(await actualPreview.textContent(), /<script>window\.__markdownUnsafe/);

    const notePreview = page.locator(
      '[data-markdown-preview="image-note"][data-tc="TC-001"][data-index="0"]',
    );
    await assert.doesNotReject(notePreview.locator("h3").waitFor());
    await assert.equal(await notePreview.locator("ol li").count(), 2);
    await assert.equal(await notePreview.locator("code").textContent(), "evidence");

    await page
      .locator('textarea[data-action="actual-result"][data-tc="TC-001"]')
      .fill("Updated **preview**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
    await assert.doesNotReject(actualPreview.locator("strong").waitFor());
    assert.match(await actualPreview.textContent(), /Updated preview/);

    await page.reload();
    const reloadedActualPreview = page.locator(
      '[data-markdown-preview="actual-result"][data-tc="TC-001"]',
    );
    await assert.equal(await reloadedActualPreview.locator("table").count(), 1);
    assert.match(await reloadedActualPreview.textContent(), /Updated preview/);
  } finally {
    await browser.close();
  }
});

test("pasting html tables into actual result and notes converts them to markdown tables", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({
          id: "TC-001",
          actualResult: "",
          images: [
            {
              id: "img-1",
              dataUrl: onePixelPng,
              note: "",
              createdAt: "2026-05-19T00:01:00.000Z",
            },
          ],
        }),
      ]),
    );

    await page.goto(htmlUrl);

    const tableHtml =
      "<table><tr><th>Tab</th><th>Purpose</th></tr><tr><td>Service &amp; Month</td><td>Combined service + month analysis</td></tr><tr><td>Analyze by Service</td><td>Service-wise discrepancy analysis</td></tr></table>";
    await page
      .locator('textarea[data-action="actual-result"][data-tc="TC-001"]')
      .evaluate((textarea, html) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/html", html);
        clipboardData.setData("text/plain", "Tab\tPurpose\nService & Month\tCombined service + month analysis");
        textarea.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      }, tableHtml);

    await assert.equal(
      await page
        .locator('textarea[data-action="actual-result"][data-tc="TC-001"]')
        .inputValue(),
      "| Tab | Purpose |\n| --- | --- |\n| Service & Month | Combined service + month analysis |\n| Analyze by Service | Service-wise discrepancy analysis |",
    );
    await assert.equal(
      await page
        .locator('[data-markdown-preview="actual-result"][data-tc="TC-001"] table')
        .count(),
      1,
    );

    await page
      .locator('textarea[data-action="image-note"][data-tc="TC-001"][data-index="0"]')
      .evaluate((textarea) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "Tab\tPurpose\nAnalyze by Month\tMonth-wise discrepancy analysis");
        textarea.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      });

    assert.match(
      await page
        .locator('textarea[data-action="image-note"][data-tc="TC-001"][data-index="0"]')
        .inputValue(),
      /\| Analyze by Month \| Month-wise discrepancy analysis \|/,
    );
    await assert.equal(
      await page
        .locator(
          '[data-markdown-preview="image-note"][data-tc="TC-001"][data-index="0"] table',
        )
        .count(),
      1,
    );
  } finally {
    await browser.close();
  }
});

test("copy TC evidence renders markdown tables as table blocks in the copied image", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript((workspace) => {
      class ClipboardItemStub {
        constructor(items) {
          this.items = items;
        }
      }

      Object.defineProperty(window, "ClipboardItem", {
        value: ClipboardItemStub,
        configurable: true,
      });

      Object.defineProperty(navigator, "clipboard", {
        value: {
          async write(items) {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push(items);
          },
        },
        configurable: true,
      });

      const fillText = CanvasRenderingContext2D.prototype.fillText;
      const strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
      window.__canvasFillText = [];
      window.__canvasStrokeRects = [];
      CanvasRenderingContext2D.prototype.fillText = function patchedFillText(
        text,
        x,
        y,
        maxWidth,
      ) {
        window.__canvasFillText.push(String(text));
        return fillText.call(this, text, x, y, maxWidth);
      };
      CanvasRenderingContext2D.prototype.strokeRect = function patchedStrokeRect(
        x,
        y,
        width,
        height,
      ) {
        window.__canvasStrokeRects.push({ x, y, width, height });
        return strokeRect.call(this, x, y, width, height);
      };

      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1",
        JSON.stringify(workspace),
      );
    }, workspaceWithUploadedCases([
      testCaseFixture({
        id: "TC-001",
        actualResult:
          "| Tab | Purpose |\n| --- | --- |\n| Service & Month | Combined service + month analysis |",
        images: [
          {
            id: "img-1",
            dataUrl: onePixelPng,
            note: "| Tab | Purpose |\n| --- | --- |\n| Analyze by Month | Month-wise discrepancy analysis |",
            createdAt: "2026-05-19T00:01:00.000Z",
          },
        ],
      }),
    ]));

    await page.goto(htmlUrl);
    await page.locator('button[data-action="copy-all"][data-tc="TC-001"]').click();
    await page.waitForFunction(() => window.__clipboardWrites?.length === 1);

    const drawing = await page.evaluate(() => ({
      text: window.__canvasFillText,
      strokeRects: window.__canvasStrokeRects.length,
    }));

    assert.ok(drawing.strokeRects >= 8);
    assert.ok(drawing.text.includes("Service & Month"));
    assert.ok(drawing.text.includes("Combined service + month analysis"));
    assert.ok(!drawing.text.some((text) => text.includes("| Tab | Purpose |")));
  } finally {
    await browser.close();
  }
});

test("copy seperatly keeps markdown table text in clipboard plain text", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript((workspace) => {
      class ClipboardItemStub {
        constructor(items) {
          this.items = items;
        }
      }

      Object.defineProperty(window, "ClipboardItem", {
        value: ClipboardItemStub,
        configurable: true,
      });

      Object.defineProperty(navigator, "clipboard", {
        value: {
          async write(items) {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push(items);
          },
        },
        configurable: true,
      });

      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1",
        JSON.stringify(workspace),
      );
    }, workspaceWithUploadedCases([
      testCaseFixture({
        id: "TC-001",
        actualResult: "**Upload completed**",
        images: [
          {
            id: "img-1",
            dataUrl: onePixelPng,
            note: "| Field | Value |\n| --- | --- |\n| Status | Pass |",
            createdAt: "2026-05-19T00:01:00.000Z",
          },
        ],
      }),
    ]));

    await page.goto(htmlUrl);
    await page
      .locator('button[data-action="copy-separately"][data-tc="TC-001"]')
      .click();
    await page.waitForFunction(() => window.__clipboardWrites?.length === 1);

    const plainText = await page.evaluate(async () => {
      return window.__clipboardWrites[0][0].items["text/plain"].text();
    });

    assert.match(plainText, /Upload completed/);
    assert.doesNotMatch(plainText, /\*\*Upload completed\*\*/);
    assert.match(plainText, /\| Field \| Value \|/);
  } finally {
    await browser.close();
  }
});

test("copy seperatly does not change Copy TC Evidence merged-image behavior", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript((workspace) => {
      class ClipboardItemStub {
        constructor(items) {
          this.items = items;
        }
      }

      Object.defineProperty(window, "ClipboardItem", {
        value: ClipboardItemStub,
        configurable: true,
      });

      Object.defineProperty(navigator, "clipboard", {
        value: {
          async write(items) {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push(items);
          },
        },
        configurable: true,
      });

      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1",
        JSON.stringify(workspace),
      );
    }, {
      activeWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Evidence Workspace",
          sourceName: "source.md",
          sourceType: "markdown",
          createdAt: "2026-05-19T00:00:00.000Z",
          updatedAt: "2026-05-19T00:00:00.000Z",
          testCases: [
            {
              id: "TC-002",
              title: "Upload evidence",
              summary: "",
              relatedAc: "",
              precondition: "",
              steps: [],
              expectedResult: "",
              actualResult: "Upload completed successfully.",
              status: "pass",
              sourceLine: 12,
              images: [
                {
                  id: "img-1",
                  dataUrl: onePixelPng,
                  note: "First screen is the upload form.",
                  createdAt: "2026-05-19T00:01:00.000Z",
                },
                {
                  id: "img-2",
                  dataUrl: onePixelPng,
                  note: "",
                  createdAt: "2026-05-19T00:02:00.000Z",
                },
              ],
            },
          ],
        },
      ],
    });

    await page.goto(htmlUrl);
    await page.locator('button[data-action="copy-all"][data-tc="TC-002"]').click();
    await page.waitForFunction(() => window.__clipboardWrites?.length === 1);

    const clipboardItemCount = await page.evaluate(
      () => window.__clipboardWrites[0].length,
    );

    assert.equal(clipboardItemCount, 1);
  } finally {
    await browser.close();
  }
});

test("copy seperatly shows fallback guidance when multi-image clipboard write fails", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript((workspace) => {
      class ClipboardItemStub {
        constructor(items) {
          this.items = items;
        }
      }

      Object.defineProperty(window, "ClipboardItem", {
        value: ClipboardItemStub,
        configurable: true,
      });

      Object.defineProperty(navigator, "clipboard", {
        value: {
          async write() {
            throw new Error("The clipboard rejected multiple image items.");
          },
        },
        configurable: true,
      });

      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1",
        JSON.stringify(workspace),
      );
    }, {
      activeWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Evidence Workspace",
          sourceName: "source.md",
          sourceType: "markdown",
          createdAt: "2026-05-19T00:00:00.000Z",
          updatedAt: "2026-05-19T00:00:00.000Z",
          testCases: [
            {
              id: "TC-002",
              title: "Upload evidence",
              summary: "",
              relatedAc: "",
              precondition: "",
              steps: [],
              expectedResult: "",
              actualResult: "Upload completed successfully.",
              status: "pass",
              sourceLine: 12,
              images: [
                {
                  id: "img-1",
                  dataUrl: onePixelPng,
                  note: "First screen is the upload form.",
                  createdAt: "2026-05-19T00:01:00.000Z",
                },
                {
                  id: "img-2",
                  dataUrl: onePixelPng,
                  note: "",
                  createdAt: "2026-05-19T00:02:00.000Z",
                },
              ],
            },
          ],
        },
      ],
    });

    await page.goto(htmlUrl);
    await page
      .locator('button[data-action="copy-separately"][data-tc="TC-002"]')
      .click();

    await assert.doesNotReject(
      page
        .locator(".toast")
        .filter({ hasText: "Use Copy TC Evidence" })
        .waitFor(),
    );
  } finally {
    await browser.close();
  }
});

test("settings clear evidence files removes only uploaded Xray evidence from active workspace", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(page, {
      activeWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Active Evidence Workspace",
          sourceName: "active.md",
          sourceType: "markdown",
          createdAt: "2026-05-19T00:00:00.000Z",
          updatedAt: "2026-05-19T00:00:00.000Z",
          testCases: [
            testCaseFixture({
              id: "TC-001",
              title: "Already uploaded evidence",
              xrayUploaded: true,
            }),
            testCaseFixture({
              id: "TC-002",
              title: "Not uploaded evidence",
              xrayUploaded: false,
            }),
            testCaseFixture({
              id: "TC-003",
              title: "Uploaded with no evidence",
              xrayUploaded: true,
              images: [],
            }),
          ],
        },
        {
          id: "ws-2",
          name: "Inactive Evidence Workspace",
          sourceName: "inactive.md",
          sourceType: "markdown",
          createdAt: "2026-05-19T00:00:00.000Z",
          updatedAt: "2026-05-19T00:00:00.000Z",
          testCases: [
            testCaseFixture({
              id: "TC-004",
              title: "Inactive uploaded evidence",
              xrayUploaded: true,
            }),
          ],
        },
      ],
    });
    await page.addInitScript(() => {
      window.__confirmCalls = 0;
      window.confirm = () => {
        window.__confirmCalls += 1;
        return true;
      };
    });

    await page.goto(htmlUrl);
    await page.locator("#settingsDrawerOpenBtn").click();

    await assert.equal(
      await page.locator("#clearUploadedEvidenceFilesBtn").textContent(),
      "clear evidence files",
    );
    await assert.doesNotReject(
      page
        .getByText(
          "Clears saved evidence images only for TCs checked as Uploaded in Xray in the active workspace.",
        )
        .waitFor(),
    );

    await assert.deepEqual(await readStoredImageKeys(page), [
      "ws-1/TC-001/img-1",
      "ws-1/TC-002/img-1",
      "ws-2/TC-004/img-1",
    ]);

    await page.locator("#clearUploadedEvidenceFilesBtn").click();
    await page
      .locator(".toast", {
        hasText: "Cleared 1 evidence image from 1 uploaded Xray TC.",
      })
      .waitFor();

    assert.equal(await page.evaluate(() => window.__confirmCalls), 1);
    await assert.equal(
      await page.locator('article[data-tc="TC-001"] .image-card').count(),
      0,
    );
    await assert.equal(
      await page.locator('article[data-tc="TC-002"] .image-card').count(),
      1,
    );
    await assert.deepEqual(await readStoredImageKeys(page), [
      "ws-1/TC-002/img-1",
      "ws-2/TC-004/img-1",
    ]);

    const storedState = await readStoredState(page);
    const activeWorkspace = storedState.workspaces.find((ws) => ws.id === "ws-1");
    const inactiveWorkspace = storedState.workspaces.find((ws) => ws.id === "ws-2");
    assert.equal(activeWorkspace.remoteStatus, "modified");
    assert.deepEqual(
      activeWorkspace.testCases.map((tc) => [tc.id, tc.xrayUploaded, tc.images.length]),
      [
        ["TC-001", true, 0],
        ["TC-002", false, 1],
        ["TC-003", true, 0],
      ],
    );
    assert.deepEqual(
      inactiveWorkspace.testCases.map((tc) => [tc.id, tc.xrayUploaded, tc.images.length]),
      [["TC-004", true, 1]],
    );
  } finally {
    await browser.close();
  }
});

test("settings clear evidence files cancel keeps uploaded evidence files", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({
          id: "TC-001",
          title: "Already uploaded evidence",
          xrayUploaded: true,
        }),
      ]),
    );
    await page.addInitScript(() => {
      window.__confirmCalls = 0;
      window.confirm = () => {
        window.__confirmCalls += 1;
        return false;
      };
    });

    await page.goto(htmlUrl);
    await page.locator("#settingsDrawerOpenBtn").click();
    await page.locator("#clearUploadedEvidenceFilesBtn").click();

    assert.equal(await page.evaluate(() => window.__confirmCalls), 1);
    await assert.deepEqual(await readStoredImageKeys(page), ["ws-1/TC-001/img-1"]);
    const storedState = await readStoredState(page);
    assert.equal(storedState.workspaces[0].testCases[0].images.length, 1);
    await assert.equal(
      await page.locator('article[data-tc="TC-001"] .image-card').count(),
      1,
    );
  } finally {
    await browser.close();
  }
});

test("settings clear evidence files shows no-op toast when no uploaded evidence files match", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({
          id: "TC-001",
          title: "Not uploaded evidence",
          xrayUploaded: false,
        }),
        testCaseFixture({
          id: "TC-002",
          title: "Uploaded with no evidence",
          xrayUploaded: true,
          images: [],
        }),
      ]),
    );
    await page.addInitScript(() => {
      window.__confirmCalls = 0;
      window.confirm = () => {
        window.__confirmCalls += 1;
        return true;
      };
    });

    await page.goto(htmlUrl);
    await page.locator("#settingsDrawerOpenBtn").click();
    await page.locator("#clearUploadedEvidenceFilesBtn").click();
    await page
      .locator(".toast", {
        hasText: "No uploaded Xray evidence files to clear.",
      })
      .waitFor();

    assert.equal(await page.evaluate(() => window.__confirmCalls), 0);
    await assert.deepEqual(await readStoredImageKeys(page), ["ws-1/TC-001/img-1"]);
    const storedState = await readStoredState(page);
    assert.deepEqual(
      storedState.workspaces[0].testCases.map((tc) => [tc.id, tc.images.length]),
      [
        ["TC-001", 1],
        ["TC-002", 0],
      ],
    );
  } finally {
    await browser.close();
  }
});

test("failed testcase report bug popup saves editable bug info", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await seedWorkspace(
      page,
      workspaceWithUploadedCases([
        testCaseFixture({
          id: "TC-001",
          title: "Failed upload evidence",
          precondition: "User is on the upload page.",
          steps: ["Choose a file", "Click Upload"],
          expectedResult: "The file uploads successfully.",
          actualResult: "Upload failed with a server error.",
          status: "fail",
        }),
        testCaseFixture({
          id: "TC-002",
          title: "Passed evidence",
          status: "pass",
        }),
      ]),
    );

    await page.goto(htmlUrl);

    const reportBug = page.locator(
      'button[data-action="report-bug"][data-tc="TC-001"]',
    );
    await assert.doesNotReject(reportBug.waitFor());
    await assert.equal(
      await page
        .locator('button[data-action="report-bug"][data-tc="TC-002"]')
        .count(),
      0,
    );

    await reportBug.click();
    const dialog = page.locator("#bugReportDialog");
    await assert.equal(await dialog.getAttribute("aria-hidden"), "false");
    await assert.equal(
      await dialog.getByRole("button", { name: "Cancel" }).count(),
      1,
    );
    await assert.equal(
      await page.locator("#bugReportCopyBtn").getAttribute("class"),
      "warning",
    );
    await assert.equal(
      await page.locator("#bugReportCopyPicBtn").getAttribute("class"),
      "success",
    );
    await assert.equal(
      await page.locator("#bugReportSaveBtn").getAttribute("class"),
      "success",
    );
    await assert.equal(
      await page.locator("#bugReportCancelBtn").getAttribute("class"),
      "danger small",
    );
    await assert.equal(await page.locator("#bugReportEnv").inputValue(), "");
    await assert.equal(
      await page.locator("#bugReportPrecondition").inputValue(),
      "User is on the upload page.",
    );
    await assert.equal(
      await page.locator("#bugReportSteps").inputValue(),
      "1. Choose a file\n2. Click Upload",
    );
    await assert.equal(
      await page.locator("#bugReportActualResult").inputValue(),
      "Upload failed with a server error.",
    );
    await assert.equal(
      await page.locator("#bugReportExpectedResult").inputValue(),
      "The file uploads successfully.",
    );

    await page.locator("#bugReportEnv").fill("QA");
    await page.locator("#bugReportExpectedResult").fill("Saved expected value.");
    await page.locator("#bugReportSaveBtn").click();
    await page.locator(".toast", { hasText: "Bug report info saved" }).waitFor();

    await page.reload();
    await page
      .locator('button[data-action="report-bug"][data-tc="TC-001"]')
      .click();
    await assert.equal(await page.locator("#bugReportEnv").inputValue(), "QA");
    await assert.equal(
      await page.locator("#bugReportExpectedResult").inputValue(),
      "Saved expected value.",
    );

    await page.locator("#bugReportEnv").fill("Cancelled edit");
    await page.locator("#bugReportCancelBtn").click();
    await page
      .locator('button[data-action="report-bug"][data-tc="TC-001"]')
      .click();
    await assert.equal(await page.locator("#bugReportEnv").inputValue(), "QA");
  } finally {
    await browser.close();
  }
});

test("copy info copies only bug report text and works without screenshots", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript((workspace) => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          async writeText(text) {
            window.__clipboardTextWrites = window.__clipboardTextWrites || [];
            window.__clipboardTextWrites.push(text);
          },
          async write(items) {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push(items);
          },
        },
        configurable: true,
      });

      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1",
        JSON.stringify(workspace),
      );
    }, workspaceWithUploadedCases([
      testCaseFixture({
        id: "TC-001",
        status: "fail",
        expectedResult: "Default expected result.",
        images: [],
        bugReport: {
          env: "Stage",
          precondition: "Saved precondition.",
          stepsToReproduce: "1. Saved step",
          actualResult: "Saved actual result.",
          expectedResult: "Saved expected result.",
        },
      }),
    ]));

    await page.goto(htmlUrl);
    await page
      .locator('button[data-action="report-bug"][data-tc="TC-001"]')
      .click();
    await page.locator("#bugReportActualResult").fill("Edited actual result.");
    await page.locator("#bugReportCopyBtn").click();
    await page.waitForFunction(
      () => window.__clipboardTextWrites?.length === 1,
    );

    const payload = await page.evaluate(() => {
      return {
        imageWriteCount: window.__clipboardWrites?.length || 0,
        text: window.__clipboardTextWrites[0],
      };
    });

    assert.equal(payload.imageWriteCount, 0);
    assert.match(payload.text, /Env:\nStage/);
    assert.match(payload.text, /Precondition:\nSaved precondition\./);
    assert.match(payload.text, /Steps to Reproduce:\n1\. Saved step/);
    assert.match(payload.text, /Actual Result:\nEdited actual result\./);
    assert.match(payload.text, /Expected Result:\nSaved expected result\./);
  } finally {
    await browser.close();
  }
});

test("copy pic copies the same merged evidence image without text", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript((workspace) => {
      class ClipboardItemStub {
        constructor(items) {
          this.items = items;
        }
      }

      Object.defineProperty(window, "ClipboardItem", {
        value: ClipboardItemStub,
        configurable: true,
      });

      Object.defineProperty(navigator, "clipboard", {
        value: {
          async writeText(text) {
            window.__clipboardTextWrites = window.__clipboardTextWrites || [];
            window.__clipboardTextWrites.push(text);
          },
          async write(items) {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push(items);
          },
        },
        configurable: true,
      });

      const fillText = CanvasRenderingContext2D.prototype.fillText;
      window.__canvasFillText = [];
      CanvasRenderingContext2D.prototype.fillText = function patchedFillText(
        text,
        x,
        y,
        maxWidth,
      ) {
        window.__canvasFillText.push(String(text));
        return fillText.call(this, text, x, y, maxWidth);
      };

      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1",
        JSON.stringify(workspace),
      );
    }, workspaceWithUploadedCases([
      testCaseFixture({
        id: "TC-001",
        title: "Failed upload evidence",
        status: "fail",
        actualResult: "Upload failed.",
        images: [
          {
            id: "img-1",
            dataUrl: onePixelPng,
            note: "First screen is the upload form.",
            createdAt: "2026-05-19T00:01:00.000Z",
          },
          {
            id: "img-2",
            dataUrl: onePixelPng,
            note: "Second screen shows the error.",
            createdAt: "2026-05-19T00:02:00.000Z",
          },
        ],
      }),
    ]));

    await page.goto(htmlUrl);
    await page
      .locator('button[data-action="report-bug"][data-tc="TC-001"]')
      .click();
    await page.locator("#bugReportCopyPicBtn").click();
    await page.waitForFunction(() => window.__clipboardWrites?.length === 1);

    const popupPayload = await page.evaluate(() => ({
      types: Object.keys(window.__clipboardWrites[0][0].items).sort(),
      textWriteCount: window.__clipboardTextWrites?.length || 0,
      canvasText: [...window.__canvasFillText],
    }));

    await page.evaluate(() => {
      window.__canvasFillText = [];
    });
    await page.locator("#bugReportCancelBtn").click();
    await page.locator('button[data-action="copy-all"][data-tc="TC-001"]').click();
    await page.waitForFunction(() => window.__clipboardWrites?.length === 2);

    const tcEvidenceCanvasText = await page.evaluate(() => [
      ...window.__canvasFillText,
    ]);

    assert.deepEqual(popupPayload.types, ["image/png"]);
    assert.equal(popupPayload.textWriteCount, 0);
    assert.deepEqual(popupPayload.canvasText, tcEvidenceCanvasText);
    assert.ok(popupPayload.canvasText.includes("TC-001: Failed upload evidence"));
    assert.ok(popupPayload.canvasText.includes("First screen is the upload form."));
    assert.ok(popupPayload.canvasText.includes("Second screen shows the error."));
  } finally {
    await browser.close();
  }
});

test("copy pic requires testcase evidence screenshots", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript((workspace) => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          async write(items) {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push(items);
          },
          async writeText(text) {
            window.__clipboardTextWrites = window.__clipboardTextWrites || [];
            window.__clipboardTextWrites.push(text);
          },
        },
        configurable: true,
      });

      localStorage.setItem(
        "neustring-xray-md-evidence-builder-v1",
        JSON.stringify(workspace),
      );
    }, workspaceWithUploadedCases([
      testCaseFixture({
        id: "TC-001",
        status: "fail",
        images: [],
      }),
    ]));

    await page.goto(htmlUrl);
    await page
      .locator('button[data-action="report-bug"][data-tc="TC-001"]')
      .click();
    await page.locator("#bugReportCopyPicBtn").click();
    await page.locator(".toast", { hasText: "No evidence to copy" }).waitFor();
    await assert.equal(
      await page.evaluate(() => window.__clipboardWrites?.length || 0),
      0,
    );
    await assert.equal(
      await page.evaluate(() => window.__clipboardTextWrites?.length || 0),
      0,
    );
  } finally {
    await browser.close();
  }
});

test("standalone bug reporter opens empty without save and clears on close", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(htmlUrl);

    const standaloneButton = page.locator("#bugReporterOpenBtn");
    await assert.doesNotReject(standaloneButton.waitFor());
    await assert.equal(
      await page.locator("#settingsDrawerOpenBtn").evaluate((button) => {
        return button.previousElementSibling?.id;
      }),
      "bugReporterOpenBtn",
    );

    await standaloneButton.click();
    const dialog = page.locator("#bugReportDialog");
    await assert.equal(await dialog.getAttribute("aria-hidden"), "false");
    await assert.equal(await page.locator("#bugReportSaveBtn").isVisible(), false);
    await assert.doesNotReject(
      page.locator("#bugReportTempWarning", { hasText: "not saved" }).waitFor(),
    );
    await assert.equal(await page.locator("#bugReportEnv").inputValue(), "");
    await assert.equal(
      await page.locator("#bugReportPrecondition").inputValue(),
      "",
    );
    await assert.equal(await page.locator("#bugReportSteps").inputValue(), "");
    await assert.equal(
      await page.locator("#bugReportActualResult").inputValue(),
      "",
    );
    await assert.equal(
      await page.locator("#bugReportExpectedResult").inputValue(),
      "",
    );

    await page.locator("#bugReportEnv").fill("Standalone QA");
    await page.locator("#standaloneBugReportDropzone").evaluate(
      async (zone, dataUrl) => {
        const blob = await (await fetch(dataUrl)).blob();
        const file = new File([blob], "standalone.png", { type: "image/png" });
        const clipboardData = new DataTransfer();
        clipboardData.items.add(file);
        zone.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      },
      onePixelPng,
    );
    await page.locator("#standaloneBugReportImages .image-card").first().waitFor();

    await page.locator("#bugReportCancelBtn").click();
    await standaloneButton.click();
    await assert.equal(await page.locator("#bugReportEnv").inputValue(), "");
    await assert.equal(
      await page.locator("#standaloneBugReportImages .image-card").count(),
      0,
    );
  } finally {
    await browser.close();
  }
});

test("standalone copy info writes only manual bug report text", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          async writeText(text) {
            window.__clipboardTextWrites = window.__clipboardTextWrites || [];
            window.__clipboardTextWrites.push(text);
          },
          async write(items) {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push(items);
          },
        },
        configurable: true,
      });
    });

    await page.goto(htmlUrl);
    await page.locator("#bugReporterOpenBtn").click();
    await page.locator("#bugReportEnv").fill("Production");
    await page.locator("#bugReportPrecondition").fill("User is signed in.");
    await page.locator("#bugReportSteps").fill("1. Open dashboard\n2. Click Export");
    await page.locator("#bugReportActualResult").fill("Export fails.");
    await page.locator("#bugReportExpectedResult").fill("CSV downloads.");
    await page.locator("#bugReportCopyBtn").click();
    await page.waitForFunction(() => window.__clipboardTextWrites?.length === 1);

    const payload = await page.evaluate(() => ({
      imageWriteCount: window.__clipboardWrites?.length || 0,
      text: window.__clipboardTextWrites[0],
    }));

    assert.equal(payload.imageWriteCount, 0);
    assert.equal(
      payload.text,
      [
        "Env:\nProduction",
        "Precondition:\nUser is signed in.",
        "Steps to Reproduce:\n1. Open dashboard\n2. Click Export",
        "Actual Result:\nExport fails.",
        "Expected Result:\nCSV downloads.",
      ].join("\n\n"),
    );
  } finally {
    await browser.close();
  }
});

test("standalone copy pic merges pasted screenshots without text", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.addInitScript(() => {
      class ClipboardItemStub {
        constructor(items) {
          this.items = items;
        }
      }

      Object.defineProperty(window, "ClipboardItem", {
        value: ClipboardItemStub,
        configurable: true,
      });
      Object.defineProperty(navigator, "clipboard", {
        value: {
          async writeText(text) {
            window.__clipboardTextWrites = window.__clipboardTextWrites || [];
            window.__clipboardTextWrites.push(text);
          },
          async write(items) {
            window.__clipboardWrites = window.__clipboardWrites || [];
            window.__clipboardWrites.push(items);
          },
        },
        configurable: true,
      });

      const fillText = CanvasRenderingContext2D.prototype.fillText;
      window.__canvasFillText = [];
      CanvasRenderingContext2D.prototype.fillText = function patchedFillText(
        text,
        x,
        y,
        maxWidth,
      ) {
        window.__canvasFillText.push(String(text));
        return fillText.call(this, text, x, y, maxWidth);
      };
    });

    await page.goto(htmlUrl);
    await page.locator("#bugReporterOpenBtn").click();
    await page.locator("#standaloneBugReportDropzone").evaluate(
      async (zone, dataUrl) => {
        const clipboardData = new DataTransfer();
        for (const name of ["first.png", "second.png"]) {
          const blob = await (await fetch(dataUrl)).blob();
          clipboardData.items.add(
            new File([blob], name, { type: "image/png" }),
          );
        }
        zone.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
      },
      onePixelPng,
    );
    await page
      .locator("#standaloneBugReportImages .image-card")
      .nth(1)
      .waitFor();

    await page
      .locator('textarea[data-action="standalone-bug-image-note"][data-index="0"]')
      .fill("First standalone screen.");
    await page
      .locator('textarea[data-action="standalone-bug-image-note"][data-index="1"]')
      .fill("Second standalone screen.");
    await page
      .locator('button[data-action="standalone-bug-move-down"][data-index="0"]')
      .click();
    await page.locator("#bugReportActualResult").fill("Manual bug failed.");
    await page.locator("#bugReportCopyPicBtn").click();
    await page.waitForFunction(() => window.__clipboardWrites?.length === 1);

    const payload = await page.evaluate(() => ({
      types: Object.keys(window.__clipboardWrites[0][0].items).sort(),
      textWriteCount: window.__clipboardTextWrites?.length || 0,
      canvasText: [...window.__canvasFillText],
    }));

    assert.deepEqual(payload.types, ["image/png"]);
    assert.equal(payload.textWriteCount, 0);
    assert.ok(payload.canvasText.includes("Bug Report: Manual report"));
    assert.ok(payload.canvasText.includes("Manual bug failed."));
    assert.ok(payload.canvasText.includes("Second standalone screen."));
    assert.ok(payload.canvasText.includes("First standalone screen."));
    assert.ok(
      payload.canvasText.indexOf("Second standalone screen.") <
        payload.canvasText.indexOf("First standalone screen."),
    );
  } finally {
    await browser.close();
  }
});

test("help icon opens the embedded user manual with setup guidance", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(htmlUrl);

    const helpButton = page.locator("#helpToggleBtn");
    await assert.doesNotReject(helpButton.waitFor());
    await assert.equal(
      await helpButton.evaluate((button) => button.previousElementSibling?.id),
      "themeToggleBtn",
    );

    await helpButton.click();

    const helpDialog = page.locator("#helpDialog");
    await assert.doesNotReject(helpDialog.waitFor());
    await assert.equal(await helpDialog.getAttribute("aria-hidden"), "false");
    await assert.doesNotReject(
      helpDialog.getByText("Fresh Setup").waitFor(),
    );
    await assert.doesNotReject(
      helpDialog.getByText("Run setup in terminal").waitFor(),
    );
    await assert.doesNotReject(
      helpDialog.getByText("Node.js is required").waitFor(),
    );
    await assert.doesNotReject(
      helpDialog.getByText("npm run evidence:workflow").first().waitFor(),
    );
    await assert.doesNotReject(
      helpDialog
        .getByText("Create a Personal Access Token with gist scope")
        .waitFor(),
    );
    await assert.doesNotReject(
      helpDialog.getByText("Bug Reporting").waitFor(),
    );
    await assert.doesNotReject(
      helpDialog.getByText("Bug Reporter button").waitFor(),
    );
    await assert.doesNotReject(
      helpDialog.getByText("Report Bug").first().waitFor(),
    );
    await assert.doesNotReject(
      helpDialog.getByText("Copy info").first().waitFor(),
    );
    await assert.doesNotReject(
      helpDialog.getByText("Copy pic").first().waitFor(),
    );
  } finally {
    await browser.close();
  }
});
