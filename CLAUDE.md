# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A local-first browser tool for building Jira Xray evidence packages from Markdown/CSV test case files, plus an optional Node/Playwright automation layer that uploads that evidence into Xray directly. Everything runs on the user's machine; no screenshots or evidence are uploaded to any third party except when the user explicitly runs the Xray automation or Gist sync.

There are two separate deliverables in this repo — don't conflate them:
- `xray-md-evidence.html` — the actual tool. A single self-contained HTML file (~5800 lines) with all CSS/JS inline in one `<script>` block starting around line 1955. It must stay a fully self-contained file that can be shared and opened standalone (see README "Share only the tool"), so avoid introducing external script/CSS dependencies or a build step.
- `index.html` — a separate static marketing/landing page, unrelated to the tool's runtime. It is the only file deployed by `.github/workflows/pages.yml` (copied verbatim into `_site/` on push to `main`).

## Commands

```sh
npm run setup             # npm install + npx playwright install chromium
npm run doctor            # preflight check: Node version, deps, Chromium launchable, port status
npm run evidence          # open xray-md-evidence.html directly in the OS browser (no server, no Xray automation)
npm run evidence:workflow # start the local Node server (workflow/server.js) and open it — required for Xray automation
npm run xray:login        # standalone Playwright login flow to (re)save the Jira/Xray session
npm test                  # node --test tests/*.test.js workflow/*.test.js
```

Run a single test file directly (the test suite is Node's built-in runner, not Jest/Mocha):

```sh
node --test tests/xray-md-evidence.test.js
node --test tests/index-page.test.js
node --test workflow/xray-workflow.test.js
node --test --test-name-pattern="<substring>" tests/xray-md-evidence.test.js
```

`tests/xray-md-evidence.test.js` and `workflow/xray-workflow.test.js` launch real Chromium via Playwright, so `npm run setup` must have been run first. There is no lint script configured in `package.json`; `.hintrc` (webhint) exists but is not wired into `npm test`.

## Architecture

**Frontend (`xray-md-evidence.html`)**
- Single-page app, no framework, no bundler. All state lives in browser `localStorage` under the key `neustring-xray-md-evidence-builder-v1` (a JSON blob of workspaces → test cases → screenshots/notes/status). There is no backend persistence for evidence data — exporting/importing JSON and optional GitHub Gist sync are the only ways data leaves the browser.
- Parses Markdown or CSV test case files client-side (supports two CSV shapes: standard `Test Case ID/Summary/Steps/Preconditions/Expected Result`, and "Deal Summary" style `Action`/`Data` columns).
- Screenshot evidence is combined into Xray-compatible clipboard images entirely in-browser (Canvas/Clipboard APIs) — `Copy TC Evidence` and `copy seperatly` are the two clipboard-image code paths and have different browser/OS support caveats; check both when touching clipboard logic.

**Local workflow server (`workflow/`)**
- `workflow/server.js` is a dependency-free `http` server. It serves `xray-md-evidence.html` at `/`, and exposes a JSON API for the Xray automation:
  - `GET /health` — used both by clients and by the server's own startup logic to detect "a compatible instance is already running on this port" vs. a genuine port conflict.
  - `POST /workflow/start`, `GET /workflow/:id`, `POST /workflow/:id/cancel` — async run lifecycle; runs are tracked in-memory (`runs` Map) with logs, and cancellation is wired through an `AbortController` plus an `onBrowser` hook so an in-flight Playwright browser can be closed mid-run.
  - `POST /setup/run` — spawns `npm run setup && npm run doctor && npm run evidence:workflow` in a new OS terminal window (platform-specific launch commands live in `buildSetupLaunchCommand`).
  - Default port `39291`, overridable via `XRAY_WORKFLOW_PORT`; on `EADDRINUSE` it probes up to `XRAY_PORT_ATTEMPTS` (default 20) additional ports, treating an existing *healthy Xray server* on that port as success rather than failure.
- `workflow/xray-workflow.js` is the actual Playwright automation: launches Chromium, reuses a saved Jira session if present, navigates the Xray test-execution board, matches test cases by **title/name text tokens visible in the evidence card** (the local `TC-001` label is never sent to Xray and is not used for matching — see `wordTokensForMatch`/`tokensContainExactSequence`), pastes the evidence PNG, sets pass/fail, and saves. It writes a structured debug trail to `workflow/workflow-debug.log` (gitignored) via `logDebug`.
- `workflow/jira-session.js` manages the persisted Playwright `storageState` at `.xray-auth/jira-xray-auth-state.json` (gitignored — treat as a credential). It detects login/2FA challenge pages and gives the user a 3-minute manual-login window (`MANUAL_LOGIN_TIMEOUT_MS`) before saving the session.
- `workflow/selectors.js` centralizes the brittle Jira/Xray DOM selectors and the hardcoded test-executions URL (project `NS` on `yaanainc.atlassian.net`). When Xray's UI changes break automation, this is the first file to check/update.
- `workflow/login.js` is a standalone CLI entry point (`npm run xray:login`) that reuses `jira-session.js` to refresh the saved session outside of the full workflow.

**Testing conventions**
- `tests/xray-md-evidence.test.js` drives the real app end-to-end in Chromium via Playwright against the `file://` URL of `xray-md-evidence.html`. Tests seed state by injecting into `localStorage` with `page.addInitScript` *before* the page loads (`seedWorkspace`), then read it back with `page.evaluate` (`readStoredState`). These are browser-level tests of the shipped HTML file, not isolated unit tests — there's no separate "logic module" to import.
- `tests/index-page.test.js` is a plain Node test using string/regex assertions against the raw `index.html` content — no browser involved.
- `workflow/xray-workflow.test.js` tests the Playwright automation module (`workflow/xray-workflow.js`) directly.

## Conventions

- Plain CommonJS throughout Node-side code (`require`/`module.exports`), no TypeScript, no transpilation.
- Product name is **NeuString** — spell it with a capital S when it appears in docs/UI copy.
