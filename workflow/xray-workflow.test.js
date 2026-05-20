const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  buildChromiumLaunchOptions,
  clickActualResultEditFallback,
  clickActualResultSaveButton,
  getXrayRowExecutionStatusFromText,
  isPointerInterceptionError,
  normalizeBrowserMode,
  normalizeWorkflowStatus,
  requireExecutionStatus,
  shouldSkipExecutedRow,
} = require("./xray-workflow");
const {
  buildSetupLaunchCommand,
  checkExistingWorkflowService,
  startWorkflowServer,
  isWorkflowServiceHealth,
  validateWorkflowPayload,
} = require("./server");

test("normalizes workflow item statuses", () => {
  assert.equal(normalizeWorkflowStatus("pass"), "pass");
  assert.equal(normalizeWorkflowStatus("fail"), "fail");
  assert.equal(normalizeWorkflowStatus("PASS"), "pass");
  assert.equal(normalizeWorkflowStatus("anything else"), "pass");
  assert.equal(normalizeWorkflowStatus(undefined), "pass");
});

test("requires Xray execution status click to report workflow success", async () => {
  await assert.rejects(
    () => requireExecutionStatus({}, "pass", async () => false, async () => true),
    /Could not set Xray status to pass/,
  );
  await assert.doesNotReject(() =>
    requireExecutionStatus({}, "fail", async () => true, async () => true),
  );
});

test("requires Xray execution status confirmation after click", async () => {
  await assert.rejects(
    () => requireExecutionStatus({}, "pass", async () => true, async () => false),
    /Xray status did not confirm as pass/,
  );
  await assert.doesNotReject(() =>
    requireExecutionStatus({}, "pass", async () => true, async () => true),
  );
});

test("validates optional workflow status in payload items", () => {
  const payload = validateWorkflowPayload({
    testExecutionSummary: "NS-15838 Test Execution",
    mode: "single",
    items: [
      {
        testcaseName: "TC 1",
        evidencePngDataUrl: "data:image/png;base64,AAAA",
        status: "PASS",
      },
      {
        testcaseName: "TC 2",
        evidencePngDataUrl: "data:image/png;base64,BBBB",
      },
    ],
  });

  assert.deepEqual(
    payload.items.map((item) => item.status),
    ["pass", "pass"],
  );
});

test("recognizes existing workflow service health response", () => {
  assert.equal(
    isWorkflowServiceHealth(
      { service: "Xray workflow service", status: "ready", port: 39291 },
      39291,
    ),
    true,
  );
  assert.equal(
    isWorkflowServiceHealth(
      { service: "Something else", status: "ready", port: 39291 },
      39291,
    ),
    false,
  );
});

test("checks whether occupied port belongs to workflow service", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          service: "Xray workflow service",
          status: "ready",
          port: server.address().port,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(
      await checkExistingWorkflowService(server.address().port, "127.0.0.1"),
      true,
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function getLocalPath(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path,
        timeout: 2000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`GET ${path} timed out`));
    });
    req.on("error", reject);
  });
}

test("serves the evidence UI from the local workflow server root", async () => {
  const server = await startWorkflowServer({ port: 0, host: "127.0.0.1" });

  try {
    const response = await getLocalPath(server.address().port, "/");

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Xray Markdown Evidence Builder/);
    assert.match(response.body, /WORKFLOW_SERVICE_URL/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("reports the actual local port when started dynamically", async () => {
  const server = await startWorkflowServer({ port: 0, host: "127.0.0.1" });

  try {
    const port = server.address().port;
    const response = await getLocalPath(port, "/health");
    const payload = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(payload.status, "ready");
    assert.equal(payload.port, port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("setup terminal command runs setup, doctor, and app launch", () => {
  const launch = buildSetupLaunchCommand("C:\\repo\\Xray-Evidence");
  const commandText = [launch.command, ...launch.args].join(" ");

  assert.match(commandText, /npm run setup/);
  assert.match(commandText, /npm run doctor/);
  assert.match(commandText, /npm run evidence:workflow/);
});

test("normalizes workflow browser mode", () => {
  assert.equal(normalizeBrowserMode("headed"), "headed");
  assert.equal(normalizeBrowserMode("headless"), "headless");
  assert.equal(normalizeBrowserMode("HEADed"), "headed");
  assert.equal(normalizeBrowserMode("invalid"), "headless");
  assert.equal(normalizeBrowserMode(undefined), "headless");
});

test("validates optional browser mode in workflow payload", () => {
  const payload = validateWorkflowPayload({
    testExecutionSummary: "NS-15838 Test Execution",
    browserMode: "headed",
    items: [
      {
        testcaseName: "TC 1",
        evidencePngDataUrl: "data:image/png;base64,AAAA",
      },
    ],
  });

  assert.equal(payload.browserMode, "headed");
});

test("defaults invalid workflow browser mode to headless", () => {
  const payload = validateWorkflowPayload({
    testExecutionSummary: "NS-15838 Test Execution",
    browserMode: "visible",
    items: [
      {
        testcaseName: "TC 1",
        evidencePngDataUrl: "data:image/png;base64,AAAA",
      },
    ],
  });

  assert.equal(payload.browserMode, "headless");
});

test("builds Playwright launch options from browser mode", () => {
  assert.equal(buildChromiumLaunchOptions("headless").headless, true);
  assert.equal(buildChromiumLaunchOptions("headed").headless, false);
  assert.equal(buildChromiumLaunchOptions("invalid").headless, true);
});

test("detects Xray execution row statuses from visible row text", () => {
  assert.equal(getXrayRowExecutionStatusFromText("62\nNS-21493\nName\nMANUAL\nNEW\nPASSED"), "passed");
  assert.equal(getXrayRowExecutionStatusFromText("62 NS-21493 Name MANUAL NEW FAILED"), "failed");
  assert.equal(getXrayRowExecutionStatusFromText("59 NS-21496 Name MANUAL NEW TO DO"), "todo");
  assert.equal(getXrayRowExecutionStatusFromText("59 NS-21496 Name MANUAL NEW"), "unknown");
});

test("skips only already executed rows", () => {
  assert.equal(shouldSkipExecutedRow("passed"), true);
  assert.equal(shouldSkipExecutedRow("failed"), true);
  assert.equal(shouldSkipExecutedRow("todo"), false);
  assert.equal(shouldSkipExecutedRow("unknown"), false);
});

test("detects Playwright pointer interception errors", () => {
  assert.equal(
    isPointerInterceptionError(
      new Error(
        '<div class="richMedia-resize-handle-left"></div> intercepts pointer events',
      ),
    ),
    true,
  );
  assert.equal(isPointerInterceptionError(new Error("button is disabled")), false);
});

test("finds Actual Result Edit when the label container has no controls", async () => {
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <main>
        <div><span>Actual Result</span></div>
        <div>
          <button type="button" id="edit">Edit</button>
        </div>
        <script>
          window.editClicks = 0;
          document.getElementById("edit").addEventListener("click", () => {
            window.editClicks += 1;
          });
        </script>
      </main>
    `);

    assert.equal(await clickActualResultEditFallback(page, "TC label-only section"), true);
    assert.equal(await page.evaluate(() => window.editClicks), 1);
  } finally {
    await browser.close();
  }
});

test("opens Actual Result editor from click-to-edit preview", async () => {
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <main>
        <section>
          <h3>Actual Result</h3>
          <div id="preview" title="Click to edit">Preview unavailable</div>
        </section>
        <script>
          document.getElementById("preview").addEventListener("click", () => {
            const editor = document.createElement("div");
            editor.setAttribute("contenteditable", "true");
            editor.textContent = "";
            document.querySelector("section").appendChild(editor);
          });
        </script>
      </main>
    `);

    assert.equal(await clickActualResultEditFallback(page, "TC preview editor"), true);
    await page.locator('[contenteditable="true"]').waitFor();
  } finally {
    await browser.close();
  }
});

test("falls back to DOM click when rich media overlay intercepts Save", async () => {
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <button id="save" type="button" style="position:absolute;left:80px;top:80px;width:100px;height:40px">Save</button>
      <div class="richMedia-resize-handle-left" style="position:absolute;left:70px;top:70px;width:140px;height:70px;background:rgba(255,0,0,0.01)"></div>
      <script>
        window.saved = 0;
        document.getElementById("save").addEventListener("click", () => {
          window.saved += 1;
        });
      </script>
    `);

    await clickActualResultSaveButton(page.locator("#save"), "TC overlay test");
    assert.equal(await page.evaluate(() => window.saved), 1);
  } finally {
    await browser.close();
  }
});
