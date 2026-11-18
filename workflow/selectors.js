// Stable Jira entry point. The Xray Testing Board is reached from here through the
// sidebar (Apps > Xray > Testing Board) instead of a hardcoded Xray URL, because the
// Xray app route embeds per-site app/environment UUIDs that change when Xray is
// migrated or reinstalled (it already moved from a Connect to a Forge app once).
const JIRA_PROJECT_URL =
  "https://yaanainc.atlassian.net/jira/software/projects/NS/summary";

// Accessible names of the sidebar controls used to reach the Testing Board.
const XRAY_SIDEBAR_NAMES = {
  apps: /^Apps$/,
  xray: /^Xray$/,
  testingBoard: /^Testing Board$/,
  expandSidebar: /expand sidebar/i,
};

// URL path of the Xray app route once the Testing Board link has been clicked.
const XRAY_BOARD_PATH_PATTERN = /\/testing-board(?:[/?#]|$)/i;

// Frames that may host the Xray UI: Forge apps render from *.atlassian-dev.net,
// legacy Connect apps from URLs that mention xray/xpandit/atlassian-connect.
const XRAY_FRAME_URL_PATTERN =
  /atlassian-dev\.net|xray|xpandit|testing-board|atlassian-connect/i;

const PLAY_BUTTON_FALLBACK_SELECTOR =
  "#testing-board > div > div > div.sc-eTyWNx.hMlFOl > div:nth-child(2) > div.draggable-block-list-context > div > div.draggable-block-list-item.selected > div > div.sc-izvnbC.gNKmzt > div > button";

const TEST_EXECUTION_LINK_FALLBACK_SELECTOR =
  "#testing-board > div > div > div.sc-juQqkt.khsnJQ.sc-jMvuUo.fjnxPS > div > div > div > div.draggable-block-list-item.selected > div > div.sc-izvnbC.gWjrSI > div:nth-child(1) > span.sc-gMcBNU.dzUxvi > div > div > a > span > span";

const SEARCH_INPUT_SELECTORS = [
  'input[placeholder*="Search" i]',
  'input[type="search"]',
  '[role="searchbox"]',
  'input[aria-label*="Search" i]',
];

const ACTUAL_RESULT_TARGETS = [
  'button:has-text("Actual Result")',
  'text=/^Actual Result$/i',
  '[aria-label*="Actual Result" i]',
];

const SAVE_TARGETS = [
  'button:has-text("Save")',
  'button[aria-label*="Save" i]',
  '[role="button"]:has-text("Save")',
];

module.exports = {
  ACTUAL_RESULT_TARGETS,
  JIRA_PROJECT_URL,
  PLAY_BUTTON_FALLBACK_SELECTOR,
  SAVE_TARGETS,
  SEARCH_INPUT_SELECTORS,
  TEST_EXECUTION_LINK_FALLBACK_SELECTOR,
  XRAY_BOARD_PATH_PATTERN,
  XRAY_FRAME_URL_PATTERN,
  XRAY_SIDEBAR_NAMES,
};
