const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const indexHtml = readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const pagesWorkflowPath = path.resolve(
  __dirname,
  "..",
  ".github",
  "workflows",
  "pages.yml",
);

test("landing page keeps the release download CTA and author footer", () => {
  assert.match(
    indexHtml,
    /href="https:\/\/github\.com\/shikdershondhi\/Xray-Evidence\/releases\/latest"/,
  );
  assert.match(indexHtml, />\s*Download App\s*</);
  assert.match(indexHtml, /Built by SHIKDER SHONDHI/);
});

test("landing page includes persistent system-aware theme controls", () => {
  assert.match(indexHtml, /id="themeToggle"/);
  assert.match(indexHtml, /xray-evidence-page-theme/);
  assert.match(indexHtml, /localStorage/);
  assert.match(indexHtml, /prefers-color-scheme:\s*dark/);
  assert.match(indexHtml, /data-theme/);
});

test("landing page advertises the expected developer-tool feature surface", () => {
  for (const text of [
    "Markdown and CSV",
    "Clipboard evidence",
    "Local Playwright",
    "Local-only data",
    "Gist sync",
    "Fresh-copy setup",
    "Uploaded evidence cleanup",
    "clear saved screenshot files",
    "npm run setup",
    "npm run doctor",
    "npm run evidence:workflow",
  ]) {
    assert.match(indexHtml, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("GitHub Pages workflow deploys the static landing page artifact", () => {
  assert.equal(existsSync(pagesWorkflowPath), true);

  const workflow = readFileSync(pagesWorkflowPath, "utf8");

  assert.match(workflow, /branches:\s*\n\s+- main/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /uses: actions\/configure-pages@v5/);
  assert.doesNotMatch(workflow, /node --test/);
  assert.doesNotMatch(workflow, /npx playwright install/);
  assert.doesNotMatch(workflow, /npm test/);
  assert.doesNotMatch(workflow, /npm ci/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /uses: actions\/deploy-pages@v4/);
  assert.match(workflow, /path: _site/);
  assert.match(workflow, /Copy landing page/);
});
