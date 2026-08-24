const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const {
  closeSharedBrowser,
  normalizeBrowserMode,
  normalizeWorkflowStatus,
  runXrayWorkflow,
} = require("./xray-workflow");

const PORT = Number(process.env.XRAY_WORKFLOW_PORT || 39291);
const HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = Number(process.env.XRAY_PORT_ATTEMPTS || 20);
const MAX_BODY_BYTES = 500 * 1024 * 1024;
const SERVICE_NAME = "Xray workflow service";
const HTML_PATH = path.resolve(__dirname, "../xray-md-evidence.html");
const ROOT_DIR = path.resolve(__dirname, "..");
const SERVER_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();
const FINAL_RUN_STATUSES = new Set(["success", "partial", "failed", "cancelled"]);
const RUN_WATCHDOG_MS = Number(process.env.XRAY_RUN_WATCHDOG_MS || 10 * 60 * 1000);
const runs = new Map();
const runControls = new Map();
const runQueue = [];
let queueActive = false;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, body) => {
    if (error) {
      sendText(res, 500, "Could not load Xray Evidence UI.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(body);
  });
}

function isWorkflowServiceHealth(payload, port = PORT) {
  return (
    payload?.service === SERVICE_NAME &&
    payload?.status === "ready" &&
    Number(payload?.port) === Number(port)
  );
}

function checkExistingWorkflowService(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: host,
        port,
        path: "/health",
        timeout: 1500,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(isWorkflowServiceHealth(JSON.parse(body), port));
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function readJsonBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        const error = new Error("Request body is too large.");
        error.responded = true;
        sendJson(res, 413, { error: error.message });
        reject(error);
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function validateWorkflowPayload(payload) {
  const testExecutionSummary = String(payload.testExecutionSummary || "").trim();
  const mode = payload.mode === "batch" ? "batch" : "single";
  const browserMode = normalizeBrowserMode(payload.browserMode);
  const items = Array.isArray(payload.items) ? payload.items : [];

  if (!testExecutionSummary) {
    throw new Error("Test execution summary is required.");
  }
  if (!items.length) {
    throw new Error("At least one testcase evidence item is required.");
  }

  const normalizedItems = items.map((item, index) => {
    const testcaseName = String(item.testcaseName || "").trim();
    const evidencePngDataUrl = String(item.evidencePngDataUrl || "");
    if (!testcaseName) {
      throw new Error(`Item ${index + 1} is missing testcaseName.`);
    }
    if (!/^data:image\/png;base64,/.test(evidencePngDataUrl)) {
      throw new Error(`Item ${index + 1} is missing a PNG evidence data URL.`);
    }
    const status = normalizeWorkflowStatus(item.status);
    return { testcaseName, evidencePngDataUrl, status };
  });

  return { testExecutionSummary, mode, browserMode, items: normalizedItems };
}

function createRun(payload) {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const run = {
    runId,
    status: "queued",
    message: "Workflow queued.",
    payloadSummary: {
      mode: payload.mode,
      browserMode: payload.browserMode,
      testExecutionSummary: payload.testExecutionSummary,
      itemCount: payload.items.length,
    },
    results: [],
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  runs.set(runId, run);
  runControls.set(runId, {
    controller: new AbortController(),
  });
  return run;
}

function appendRunLog(runId, entry) {
  const run = runs.get(runId);
  if (!run) return;
  const logEntry = {
    time: new Date().toISOString(),
    level: ["info", "warn", "error"].includes(entry?.level) ? entry.level : "info",
    testcaseName: String(entry?.testcaseName || ""),
    message: String(entry?.message || "").trim() || "Workflow update.",
  };
  run.logs.push(logEntry);
  run.updatedAt = logEntry.time;
}

function appendRunResult(runId, result) {
  const run = runs.get(runId);
  if (!run) return;
  run.results.push(result);
  run.updatedAt = new Date().toISOString();
}

function updateRun(runId, patch) {
  const run = runs.get(runId);
  if (!run) return;
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
}

function isWorkflowCancelledError(error) {
  return error?.code === "XRAY_WORKFLOW_CANCELLED";
}

function markRunCancelled(runId, message = "Workflow cancelled.") {
  const run = runs.get(runId);
  if (run?.status === "cancelled") return;
  appendRunLog(runId, {
    level: "warn",
    testcaseName: "",
    message,
  });
  updateRun(runId, {
    status: "cancelled",
    message,
    results: [],
  });
}

async function executeRun(runId, payload, state) {
  const control = runControls.get(runId);
  if (control?.controller.signal.aborted) {
    markRunCancelled(runId);
    runControls.delete(runId);
    return;
  }
  updateRun(runId, { status: "running", message: "Starting Playwright." });
  const workflowRunner = state.workflowRunner || runXrayWorkflow;
  const watchdogMs = state.watchdogMs || RUN_WATCHDOG_MS;
  let watchdogTimer = null;
  let watchdogFired = false;
  let watchdogReject = null;
  const armWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogFired = true;
      control?.controller.abort();
      watchdogReject?.(new Error("Workflow timed out — the browser stopped responding."));
    }, watchdogMs);
  };
  try {
    const runnerPromise = workflowRunner(
      payload,
      (status, message, logEntry) => {
        if (control?.controller.signal.aborted) return;
        armWatchdog();
        if (logEntry) appendRunLog(runId, logEntry);
        updateRun(runId, { status, message });
      },
      {
        signal: control?.controller.signal,
        onResult: (result) => {
          if (control?.controller.signal.aborted) return;
          armWatchdog();
          appendRunResult(runId, result);
        },
      },
    );
    runnerPromise.catch(() => {});
    const watchdogPromise = new Promise((_, reject) => {
      watchdogReject = reject;
      armWatchdog();
    });
    const result = await Promise.race([runnerPromise, watchdogPromise]);
    if (control?.controller.signal.aborted) {
      markRunCancelled(runId);
      return;
    }
    updateRun(runId, { status: result.status, message: result.message });
  } catch (error) {
    if (watchdogFired) {
      await closeSharedBrowser().catch(() => {});
      appendRunLog(runId, {
        level: "error",
        testcaseName: "",
        message: error.message,
      });
      updateRun(runId, { status: "failed", message: error.message, results: [] });
      return;
    }
    if (isWorkflowCancelledError(error) || control?.controller.signal.aborted) {
      markRunCancelled(runId);
      return;
    }
    appendRunLog(runId, {
      level: "error",
      testcaseName: "",
      message: error.message || "Workflow failed.",
    });
    updateRun(runId, {
      status: "failed",
      message: error.message || "Workflow failed.",
      results: [],
    });
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    runControls.delete(runId);
  }
}

async function processQueue() {
  if (queueActive) return;
  queueActive = true;
  try {
    while (runQueue.length) {
      const next = runQueue.shift();
      await executeRun(next.runId, next.payload, next.state);
    }
  } finally {
    queueActive = false;
  }
}

function startRun(runId, payload, state = {}) {
  runQueue.push({ runId, payload, state });
  if (runQueue.length > 1) {
    updateRun(runId, {
      status: "queued",
      message: `Waiting in queue behind ${runQueue.length - 1} run(s).`,
    });
  }
  setImmediate(processQueue);
}

async function cancelRun(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  if (FINAL_RUN_STATUSES.has(run.status)) return run;

  const queueIndex = runQueue.findIndex((entry) => entry.runId === runId);
  const control = runControls.get(runId);

  if (queueIndex !== -1) {
    runQueue.splice(queueIndex, 1);
    markRunCancelled(runId, "Workflow cancelled while waiting in queue.");
    control?.controller.abort();
    runControls.delete(runId);
    return runs.get(runId);
  }

  markRunCancelled(runId);
  control?.controller.abort();
  return runs.get(runId);
}

async function handleRequest(req, res, state = { port: PORT, host: HOST }) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${state.host || HOST}:${state.port || PORT}`);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/xray-md-evidence.html")) {
    sendFile(res, HTML_PATH, "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      service: SERVICE_NAME,
      status: "ready",
      port: state.port || PORT,
      version: SERVER_VERSION,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/setup/run") {
    try {
      await startSetupTerminal();
      sendJson(res, 202, {
        status: "started",
        message: "Setup started in a new terminal.",
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error.message || "Could not start setup terminal.",
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/workflow/start") {
    try {
      const payload = validateWorkflowPayload(await readJsonBody(req, res));
      const run = createRun(payload);
      startRun(run.runId, payload, state);
      sendJson(res, 202, {
        runId: run.runId,
        status: run.status,
        message: run.message,
      });
    } catch (error) {
      if (!error.responded) {
        sendJson(res, 400, { error: error.message });
      }
    }
    return;
  }

  const cancelMatch = url.pathname.match(/^\/workflow\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    const run = await cancelRun(decodeURIComponent(cancelMatch[1]));
    if (!run) {
      sendJson(res, 404, { error: "Workflow run was not found." });
      return;
    }
    sendJson(res, 200, run);
    return;
  }

  const runMatch = url.pathname.match(/^\/workflow\/([^/]+)$/);
  if (req.method === "GET" && runMatch) {
    const run = runs.get(decodeURIComponent(runMatch[1]));
    if (!run) {
      sendJson(res, 404, { error: "Workflow run was not found." });
      return;
    }
    sendJson(res, 200, run);
    return;
  }

  sendJson(res, 404, { error: "Route not found." });
}

function openLocalUrl(url) {
  const command =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, (error) => {
    if (error) {
      console.error(`Open ${url} in Chrome or Edge.`);
    }
  });
}

function shellQuoteForDoubleQuotedCommand(value) {
  return String(value).replace(/(["`$\\])/g, "\\$1");
}

function buildSetupLaunchCommand(rootDir = ROOT_DIR) {
  const setupCommand = "npm run setup && npm run doctor && npm run evidence:workflow";

  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: [
        "/c",
        "start",
        "Xray Evidence Setup",
        "cmd",
        "/k",
        `cd /d "${rootDir}" && ${setupCommand}`,
      ],
    };
  }

  if (process.platform === "darwin") {
    const terminalCommand = `cd "${shellQuoteForDoubleQuotedCommand(rootDir)}" && ${setupCommand}`;
    return {
      command: "osascript",
      args: [
        "-e",
        `tell application "Terminal" to do script "${shellQuoteForDoubleQuotedCommand(terminalCommand)}"`,
      ],
    };
  }

  const terminalCommand = `cd "${shellQuoteForDoubleQuotedCommand(rootDir)}" && ${setupCommand}; exec sh`;
  return {
    command: "sh",
    args: [
      "-c",
      `x-terminal-emulator -e sh -c "${shellQuoteForDoubleQuotedCommand(terminalCommand)}" || gnome-terminal -- sh -c "${shellQuoteForDoubleQuotedCommand(terminalCommand)}" || konsole -e sh -c "${shellQuoteForDoubleQuotedCommand(terminalCommand)}"`,
    ],
  };
}

function startSetupTerminal(commandRunner = execFile) {
  const { command, args } = buildSetupLaunchCommand();
  return new Promise((resolve, reject) => {
    commandRunner(command, args, { cwd: ROOT_DIR, windowsHide: false }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createServer(state = { port: PORT, host: HOST }) {
  return http.createServer((req, res) => {
    handleRequest(req, res, state).catch((error) => {
      sendJson(res, 500, { error: error.message || "Internal server error." });
    });
  });
}

function listen(server, port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function startWorkflowServer({ open = false, port = PORT, host = HOST } = {}) {
  const startPort = Number(port);
  const attempts = Math.max(1, MAX_PORT_ATTEMPTS);

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidatePort = startPort + offset;
    const state = { port: candidatePort, host };
    const server = createServer(state);

    try {
      await listen(server, candidatePort, host);
      const address = server.address();
      state.port = address.port;
      const url = `http://${host}:${state.port}`;
      console.log(`Xray Evidence server listening on ${url}`);
      if (open) openLocalUrl(url);
      const shutdown = async (signal) => {
        console.log(`Received ${signal}, closing shared browser...`);
        await closeSharedBrowser().catch(() => {});
        process.exit(0);
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
      return server;
    } catch (error) {
      if (error.code !== "EADDRINUSE") {
        throw error;
      }

      const existingServiceReady = await checkExistingWorkflowService(candidatePort, host);
      if (existingServiceReady) {
        const url = `http://${host}:${candidatePort}`;
        console.log(`Xray Evidence server is already running on ${url}`);
        if (open) openLocalUrl(url);
        return null;
      }
    }
  }

  throw new Error(
    `No free local port found from ${host}:${startPort} through ${host}:${startPort + attempts - 1}. Set XRAY_WORKFLOW_PORT to a free port.`,
  );
}

if (require.main === module) {
  startWorkflowServer({ open: process.argv.includes("--open") }).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildSetupLaunchCommand,
  checkExistingWorkflowService,
  createServer,
  isWorkflowServiceHealth,
  cancelRun,
  startSetupTerminal,
  startWorkflowServer,
  validateWorkflowPayload,
};
