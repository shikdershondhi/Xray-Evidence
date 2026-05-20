const XRAY_TEST_EXECUTIONS_URL =
  "https://yaanainc.atlassian.net/projects/NS?selectedItem=com.atlassian.plugins.atlassian-connect-plugin:com.xpandit.plugins.xray__testing-board#!page=test-executions";

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
  PLAY_BUTTON_FALLBACK_SELECTOR,
  SAVE_TARGETS,
  SEARCH_INPUT_SELECTORS,
  TEST_EXECUTION_LINK_FALLBACK_SELECTOR,
  XRAY_TEST_EXECUTIONS_URL,
};
