const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("@playwright/test");

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
  } finally {
    await browser.close();
  }
});
