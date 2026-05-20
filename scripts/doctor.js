const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const defaultPort = Number(process.env.XRAY_WORKFLOW_PORT || 39291);

function logPass(message) {
  console.log(`[ok] ${message}`);
}

function logWarn(message) {
  console.log(`[warn] ${message}`);
}

function logFail(message) {
  console.log(`[fail] ${message}`);
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) {
    logPass(`Node.js ${process.version}`);
    return true;
  }
  logFail(`Node.js ${process.version}; install Node.js 18 or newer.`);
  return false;
}

function checkDependencies() {
  const packagePath = path.join(rootDir, "node_modules", "@playwright", "test", "package.json");
  if (fs.existsSync(packagePath)) {
    logPass("@playwright/test is installed");
    return true;
  }
  logFail("Dependencies are missing. Run: npm run setup");
  return false;
}

async function checkPlaywrightChromium() {
  try {
    const { chromium } = require("@playwright/test");
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    logPass("Playwright Chromium is installed and launchable");
    return true;
  } catch (error) {
    logFail("Playwright Chromium is missing or cannot launch. Run: npx playwright install chromium");
    return false;
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        timeout: 1200,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const payload = JSON.parse(body);
            if (payload?.service === "Xray workflow service" && payload?.status === "ready") {
              logPass(`Xray Evidence server is already running on http://127.0.0.1:${port}`);
              resolve(true);
              return;
            }
          } catch {
            // Fall through to generic warning below.
          }
          logWarn(`Port ${port} answered, but it is not the Xray Evidence server.`);
          resolve(true);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      logPass(`Default port ${port} is available`);
      resolve(true);
    });
    req.on("error", () => {
      logPass(`Default port ${port} is available`);
      resolve(true);
    });
  });
}

(async () => {
  const checks = [
    checkNode(),
    checkDependencies(),
    await checkPlaywrightChromium(),
    await checkPort(defaultPort),
  ];

  if (checks.every(Boolean)) {
    console.log("Doctor completed.");
    return;
  }

  process.exitCode = 1;
})();
