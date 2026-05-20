# Xray Markdown Evidence Builder

Reusable browser utility for building Jira Xray evidence from Markdown or CSV test case files.

The tool runs as a local web app. It does not upload screenshots anywhere. Evidence is saved in your browser local storage and can also be exported as a JSON backup file.

## First-Time Use

1. Pull, clone, or unzip a fresh copy of this repo.
2. Install Node.js if it is not already installed. Check with:
   - `node -v`
   - `npm -v`
3. Use Chrome or Microsoft Edge. Clipboard image copy works best in these browsers.
4. Install dependencies and Playwright Chromium:
   - `npm run setup`
5. Check the local setup:
   - `npm run doctor`
6. Start the tool:
   - `npm run evidence:workflow`
7. Load a testcase file:
   - Markdown: `.md` or `.markdown`
   - CSV: `.csv`
     - Standard CSV columns: `Test Case ID`, `Summary`, `Steps`, `Preconditions`, `Expected Result`
     - Deal Summary style CSV columns: `Test Case ID`, `Summary`, `Action`, `Data`, `Expected Result`, `Test Type`
8. The page creates a saved workspace in your current browser.

If setup fails because Playwright browsers are missing, run `npx playwright install chromium` and then retry `npm run evidence:workflow`.

## Daily Start

From the repo root, run:

```sh
npm run evidence:workflow
```

This starts one local Node server, opens the browser, and serves the tool at a `http://127.0.0.1:<port>` URL. Close the terminal or press `Ctrl+C` to stop the server.

Shortcut launch files are also included:

- Windows: `start-windows.bat`
- macOS: `start-mac.command`
- Linux: `start-linux.sh`

The in-app user manual also has a `Run setup in terminal` button. It opens a new terminal and runs:

```sh
npm run setup && npm run doctor && npm run evidence:workflow
```

That button only works when the page is opened from the local server, not when the HTML file is opened directly.

## Daily Workflow

1. Load a Markdown or CSV testcase file.
2. Read the full testcase info in each TC card:
   - Summary
   - Related AC
   - Preconditions
   - Steps
   - Expected Result
3. Click a TC paste area.
4. Copy a screenshot from your screenshot tool.
5. Paste it with `Ctrl+V`.
6. Add an optional note under the screenshot.
7. Reorder screenshots with `Up` / `Down` if needed.
8. Fill `Actual Result`.
9. Mark the TC as `Pass` or `Fail`, or leave it unset.
10. Use `Copy` for one screenshot, `Copy TC Evidence` for one combined image, or `copy seperatly` to copy all screenshots as separate clipboard image items.
11. Paste the copied evidence into Jira Xray.
12. Use the `?` hint icon beside the dark mode button any time you need the embedded user manual.

`Copy TC Evidence` keeps the existing behavior: it creates one Xray-compatible evidence image. Actual Result is placed first when filled in, then each screenshot note is placed before its screenshot in the visible order.

`copy seperatly` writes all screenshots to the clipboard at once, in the visible order, as separate image items. When Actual Result is filled, it is included as text with the first screenshot. When a screenshot has a note, the note is included above that screenshot in the copied image. Browser and OS clipboard support for multiple image items varies; if the browser rejects the copy or Jira pastes only one screenshot, use `Copy TC Evidence` for the reliable combined-image path.

## Jira Xray Workflow Automation

The `Start Workflow` buttons use the local Node server started by `npm run evidence:workflow`. A hosted static web page cannot launch Playwright by itself, so keep this repo available locally when you want automated Jira paste.

The local server API is internal to this repo. Its port, routes, and payloads can change as the workflow is rebuilt here.

1. From the repo root, run `npm run evidence:workflow`.
2. Use the local page that opens in Chrome or Edge.
3. In a TC card's `Xray Workflow` panel, enter the exact Xray test execution summary and choose Headless or Headed.
4. Use `Start Workflow` in that TC card, or `Start Workflow for All Evidence` in the workbench header for every TC with screenshots.
5. If Atlassian asks for login or 2FA, complete it in the Playwright browser within 3 minutes. The session is saved locally for later runs.

Workflow matching uses the testcase title/name visible in the evidence card. The local `TC-001` label is not sent to Xray and is not used for matching.

If the workflow service status says unavailable, run `npm run evidence:workflow` again. To refresh Jira login only, run `npm run xray:login`.

## Saving and Sharing

- Browser autosave: workspaces are saved in the browser local storage on the same machine and browser.
- Export backup: use `Export Evidence` to download a portable JSON backup.
- Import backup: use `Import Evidence` to restore a JSON backup later.
- Share with another worker: send them this tool plus the exported evidence JSON if they need your saved evidence.
- Share only the tool: send `xray-md-evidence.html`. The user manual is also embedded in the `?` hint popup, so the HTML file can be shared without this README.

Do not rely only on browser storage for important work. Export evidence JSON at the end of a session.

## GitHub Gist Sync Manual

Gist sync is optional. Use it when you want to move the same saved workspaces between browsers or machines without manually exporting/importing JSON.

1. Create a GitHub Personal Access Token with `gist` scope at `https://github.com/settings/tokens`.
2. Open the HTML tool.
3. Expand `GitHub Gist Sync` in the left panel.
4. Enter your GitHub username and the token.
5. Leave `Gist ID` empty for first setup. It is created automatically when you save settings.
6. Click `Save Settings`.
7. Click `Push to Gist` to upload the current browser workspaces.
8. On another browser or machine, open the same HTML file, enter the same username/token/Gist ID, then click `Sync from Gist`.

Security notes:

- The token is stored in this browser's local storage so the standalone HTML can sync later.
- Use a token with only `gist` scope.
- Revoke the token from GitHub if the machine is shared or the token is exposed.
- Gist sync stores the evidence JSON in your private Gist, including screenshot data saved in the workspace.

## Embedded User Manual

The `?` hint icon beside the dark mode button opens a popup containing the latest daily workflow, clipboard behavior, Gist steps, and backup notes. This is meant for single-file sharing: if you send only `xray-md-evidence.html`, the receiver still has the user manual inside the tool.

## Features

- Loads Markdown and CSV testcase files.
- Supports numeric CSV IDs such as `1`, `2`, `3` and displays them as `TC-001`, `TC-002`, `TC-003`.
- Supports CSV `Action` as testcase steps and `Data` as preconditions.
- Shows full testcase details in the page.
- Saves multiple evidence workspaces.
- Pastes screenshots directly into each TC.
- Adds screenshot order numbers.
- Reorders screenshots with `Up` / `Down`.
- Adds optional notes per screenshot.
- Copies one screenshot with its note.
- Copies all TC screenshots as one ordered evidence image, including Actual Result and screenshot notes.
- Copies TC screenshots separately in one clipboard action when the browser and OS support multiple clipboard image items.
- Tracks `Actual Result` per TC.
- Tracks TC status as `Pass`, `Fail`, or unset.
- Exports/imports evidence JSON backups.
- Exports a Markdown summary.
- Includes an embedded `?` user manual popup for single-file sharing.

## Notes

- Screenshots can make browser storage large. If storage becomes full, export your evidence JSON and remove old workspaces.
- Clipboard permissions depend on browser behavior. Chrome or Edge is recommended.
- Evidence data stays local unless you manually share the exported JSON.
