const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const {
  normalizeBrowserMode,
  normalizeWorkflowStatus,
  runXrayWorkflow,
} = require("./xray-workflow");

const PORT = Number(process.env.XRAY_WORKFLOW_PORT || 39291);
const HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = Number(process.env.XRAY_PORT_ATTEMPTS || 20);
const MAX_BODY_BYTES = 80 * 1024 * 1024;
const SERVICE_NAME = "Xray workflow service";
const HTML_PATH = path.resolve(__dirname, "../xray-md-evidence.html");
const ROOT_DIR = path.resolve(__dirname, "..");
const runs = new Map();

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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
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

function updateRun(runId, patch) {
  const run = runs.get(runId);
  if (!run) return;
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
}

function startRun(runId, payload) {
  setImmediate(async () => {
    updateRun(runId, { status: "running", message: "Starting Playwright." });
    try {
      const result = await runXrayWorkflow(payload, (status, message, logEntry) => {
        if (logEntry) appendRunLog(runId, logEntry);
        updateRun(runId, { status, message });
      });
      updateRun(runId, result);
    } catch (error) {
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
    }
  });
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
      const payload = validateWorkflowPayload(await readJsonBody(req));
      const run = createRun(payload);
      startRun(run.runId, payload);
      sendJson(res, 202, {
        runId: run.runId,
        status: run.status,
        message: run.message,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
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
  startSetupTerminal,
  startWorkflowServer,
  validateWorkflowPayload,
};
