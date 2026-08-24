# AGENTS.md

See `CLAUDE.md` for the full architecture guide; this file is the condensed version.

## What this repo is

Two independent deliverables — don't conflate them:

- `xray-md-evidence.html` — the product. A single self-contained HTML file (~5800 lines, one inline `<script>` starting ~line 1955). It must stay fully standalone/shareable: no external script/CSS dependencies, no build step. All app state lives in browser `localStorage` under `neustring-xray-md-evidence-builder-v1`; there is no backend persistence (JSON export/import + optional Gist sync are the only ways data leaves the browser).
- `index.html` — static marketing landing page only. It is the sole file deployed by `.github/workflows/pages.yml` (copied into `_site/`). Changes to it do not affect the tool.

## Commands

```sh
npm run setup             # npm install + npx playwright install chromium (required before tests)
npm run doctor            # preflight: Node version, deps, Chromium launchable
npm run evidence          # open xray-md-evidence.html in OS browser via open-evidence.js (no server)
npm run evidence:workflow # start workflow/server.js and open it — required for Xray automation
npm test                  # node --test tests/*.test.js workflow/*.test.js
```

- Test runner is Node's built-in (`node --test`), not Jest/Mocha. Single file:
  `node --test tests/xray-md-evidence.test.js`
  Filter by name: `node --test --test-name-pattern="<substring>" ...`
- `tests/xray-md-evidence.test.js` and `workflow/xray-workflow.test.js` launch real Chromium via Playwright — run `npm run setup` first or they fail.
- No lint/typecheck scripts exist. Plain CommonJS (`require`) throughout Node-side code; no TypeScript, no transpilation.
- `.hintrc` (webhint) exists but is not wired into any npm script.

## Architecture gotchas

**Tool frontend (`xray-md-evidence.html`)**
- Tests drive the shipped HTML end-to-end over `file://`. They seed state by injecting into `localStorage` with `page.addInitScript` *before* page load (`seedWorkspace`), and read back with `page.evaluate` (`readStoredState`). There is no separate logic module to unit-test.
- Screenshot evidence is composited to Xray-compatible clipboard images entirely in-browser (Canvas/Clipboard APIs). Two distinct clipboard paths — `Copy TC Evidence` (combined image) and `copy seperatly` (multiple image items) — with different browser/OS support caveats; check both when touching clipboard logic. Yes, "seperatly" is the actual UI spelling.

**Workflow server (`workflow/`)**
- `server.js`: dependency-free `http` server serving the HTML at `/` plus a JSON API for runs. Default port `39291`, override with `XRAY_WORKFLOW_PORT`; on port conflict it probes up to `XRAY_PORT_ATTEMPTS` more ports, treating an existing *healthy Xray server* there as success.
- Runs execute one at a time through a FIFO queue against a single shared Playwright browser/context/page (`getSharedBrowserContext`/`getSharedPage`) — concurrent Jira logins invalidate the shared session, so do not relaunch per run or parallelize runs. Cancellation is cooperative via `AbortController` + `throwIfWorkflowCancelled` checkpoints; it never closes the shared browser.
- `xray-workflow.js` matches test cases by **title/name text tokens visible in the evidence card**, never by the local `TC-001` label (which isn't sent to Xray). See `wordTokensForMatch`/`tokensContainExactSequence`.
- `selectors.js` centralizes brittle Jira/Xray DOM selectors and the hardcoded test-executions URL (project `NS` on `yaanainc.atlassian.net`). First place to look when Xray UI changes break automation.
- `jira-session.js` persists Playwright storageState at `.xray-auth/jira-xray-auth-state.json` (gitignored — treat as a credential). Login/2FA gets a 3-minute manual window (`MANUAL_LOGIN_TIMEOUT_MS`).
- Debug trail goes to gitignored `workflow/workflow-debug.log` via `logDebug`.

## Conventions

- Product name is **NeuString** — capital S in docs/UI copy.
