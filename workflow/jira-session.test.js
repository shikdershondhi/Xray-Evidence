const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("@playwright/test");
const {
  MANUAL_LOGIN_TIMEOUT_MS,
  isLoginUrl,
  waitForJiraAuthState,
  waitForManualLogin,
} = require("./jira-session");
const { openJiraSignedIn } = require("./xray-workflow");

const JIRA_URL = "https://yaanainc.atlassian.net/jira/software/projects/NS/summary";
const LOGIN_URL = "https://id.atlassian.com/login?continue=x";

const SHELL_HTML = `<nav><button type="button">Apps</button></nav><main>Jira</main>`;
const LOGIN_HTML = `<input type="email" placeholder="Enter your email" />`;

function html(body) {
  return { status: 200, contentType: "text/html", body: `<!doctype html><body>${body}</body>` };
}

// Serves Jira/login pages without touching the network.
async function withMockedAtlassian(handlers, run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route(/https:\/\/(yaanainc\.atlassian\.net|id\.atlassian\.com)\/.*/, (route) => {
      const url = route.request().url();
      const body = url.startsWith("https://id.atlassian.com") ? handlers.login : handlers.jira;
      return route.fulfill(html(typeof body === "function" ? body() : body));
    });
    const page = await context.newPage();
    return await run(page);
  } finally {
    await browser.close();
  }
}

test("manual login window is 5 minutes", () => {
  assert.equal(MANUAL_LOGIN_TIMEOUT_MS, 5 * 60 * 1000);
});

test("isLoginUrl recognises the Jira site login page, not only id.atlassian.com", () => {
  assert.equal(isLoginUrl("https://yaanainc.atlassian.net/login?dest-url=%2Fjira"), true);
  assert.equal(isLoginUrl("https://id.atlassian.com/login/mfa?application=jira"), true);
  assert.equal(isLoginUrl(JIRA_URL), false);
});

test("waitForJiraAuthState follows a late client-side redirect to the login page", async () => {
  // Reproduces the real bug: Jira stays on its own URL for ~2s after domcontentloaded
  // and only then redirects to id.atlassian.com, so a one-shot check wrongly saw "no login".
  await withMockedAtlassian(
    {
      jira: `<script>setTimeout(() => { location.href = "${LOGIN_URL}"; }, 1200);</script>`,
      login: LOGIN_HTML,
    },
    async (page) => {
      await page.goto(JIRA_URL, { waitUntil: "domcontentloaded" });
      const state = await waitForJiraAuthState(page, { timeoutMs: 8000, stableMs: 500 });
      assert.equal(state, "login");
    },
  );
});

test("waitForJiraAuthState reports authenticated once the Jira shell is stable", async () => {
  await withMockedAtlassian({ jira: SHELL_HTML, login: LOGIN_HTML }, async (page) => {
    await page.goto(JIRA_URL, { waitUntil: "domcontentloaded" });
    const state = await waitForJiraAuthState(page, { timeoutMs: 8000, stableMs: 500 });
    assert.equal(state, "authenticated");
  });
});

test("waitForJiraAuthState does not trust a Jira shell that redirects to login afterwards", async () => {
  await withMockedAtlassian(
    {
      jira: `${SHELL_HTML}<script>setTimeout(() => { location.href = "${LOGIN_URL}"; }, 1200);</script>`,
      login: LOGIN_HTML,
    },
    async (page) => {
      await page.goto(JIRA_URL, { waitUntil: "domcontentloaded" });
      const state = await waitForJiraAuthState(page, { timeoutMs: 8000, stableMs: 3000 });
      assert.equal(state, "login");
    },
  );
});

test("waitForJiraAuthState returns unknown when neither login nor Jira shell appears", async () => {
  await withMockedAtlassian({ jira: "<main>blank</main>", login: LOGIN_HTML }, async (page) => {
    await page.goto(JIRA_URL, { waitUntil: "domcontentloaded" });
    const state = await waitForJiraAuthState(page, { timeoutMs: 1500, stableMs: 300 });
    assert.equal(state, "unknown");
  });
});

test("waitForManualLogin keeps waiting through login/2FA and saves only after Jira loads", async () => {
  await withMockedAtlassian({ jira: SHELL_HTML, login: LOGIN_HTML }, async (page) => {
    const notices = [];
    const saves = [];
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    setTimeout(() => page.goto(JIRA_URL, { waitUntil: "domcontentloaded" }).catch(() => {}), 1500);

    await waitForManualLogin(page, (status, message) => notices.push({ status, message }), {
      timeoutMs: 15000,
      stableMs: 400,
      pollMs: 150,
      save: async () => saves.push(page.url()),
    });

    assert.equal(saves.length, 1);
    assert.match(saves[0], /yaanainc\.atlassian\.net/);
    assert.equal(notices[0].status, "waiting_for_login");
    assert.match(notices[0].message, /15 seconds/);
  });
});

test("waitForManualLogin times out without saving a session", async () => {
  await withMockedAtlassian({ jira: SHELL_HTML, login: LOGIN_HTML }, async (page) => {
    let saved = 0;
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await assert.rejects(
      () =>
        waitForManualLogin(page, () => {}, {
          timeoutMs: 1500,
          stableMs: 200,
          pollMs: 100,
          save: async () => {
            saved += 1;
          },
        }),
      /Jira login timed out after/,
    );
    assert.equal(saved, 0);
  });
});

test("waitForManualLogin sends periodic progress updates while waiting", async () => {
  await withMockedAtlassian({ jira: SHELL_HTML, login: LOGIN_HTML }, async (page) => {
    const notices = [];
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await assert.rejects(
      () =>
        waitForManualLogin(page, (status, message) => notices.push({ status, message }), {
          timeoutMs: 1800,
          heartbeatMs: 400,
          stableMs: 200,
          pollMs: 100,
          save: async () => {},
        }),
      /timed out/,
    );
    const waiting = notices.filter((item) => item.status === "waiting_for_login");
    assert.ok(waiting.length >= 3, `expected >=3 waiting notices, got ${waiting.length}`);
  });
});

const FAST_AUTH = { timeoutMs: 6000, stableMs: 400 };

// Jira shows the login redirect until `session.loggedIn` flips, then the signed-in shell.
function statefulJira(session) {
  return () =>
    session.loggedIn
      ? SHELL_HTML
      : `<script>setTimeout(() => { location.href = "${LOGIN_URL}"; }, 300);</script>`;
}

test("openJiraSignedIn refreshes the saved session only after Jira is confirmed signed in", async () => {
  await withMockedAtlassian({ jira: SHELL_HTML, login: LOGIN_HTML }, async (page) => {
    const calls = { save: 0, login: 0 };
    const result = await openJiraSignedIn(page, "headless", () => {}, {
      authOptions: FAST_AUTH,
      deps: {
        saveJiraSession: async () => (calls.save += 1),
        loginInVisibleBrowser: async () => (calls.login += 1),
      },
    });
    assert.equal(result, page);
    assert.deepEqual(calls, { save: 1, login: 0 });
  });
});

test("openJiraSignedIn never saves a session when Jira redirects to login after domcontentloaded", async () => {
  const session = { loggedIn: false };
  await withMockedAtlassian({ jira: statefulJira(session), login: LOGIN_HTML }, async (page) => {
    let saved = 0;
    await assert.rejects(
      () =>
        openJiraSignedIn(page, "headed", () => {}, {
          authOptions: FAST_AUTH,
          deps: { saveJiraSession: async () => (saved += 1) },
          signal: AbortSignal.timeout(2500),
        }),
      (error) => error.code === "XRAY_WORKFLOW_CANCELLED",
    );
    assert.equal(saved, 0);
  });
});

test("openJiraSignedIn in headless mode hands login to a visible browser, then continues headless", async () => {
  const session = { loggedIn: false };
  await withMockedAtlassian({ jira: statefulJira(session), login: LOGIN_HTML }, async (page) => {
    const events = [];
    const notices = [];
    let freshPage = null;
    const result = await openJiraSignedIn(page, "headless", (status, message) => notices.push({ status, message }), {
      authOptions: FAST_AUTH,
      deps: {
        loginInVisibleBrowser: async () => {
          events.push("visible-login");
          session.loggedIn = true;
        },
        closeSharedBrowser: async () => events.push("close-shared"),
        getSharedPage: async (mode) => {
          events.push(`new-page:${mode}`);
          freshPage = await page.context().newPage();
          return freshPage;
        },
        saveJiraSession: async () => events.push("save"),
      },
    });

    assert.deepEqual(events, ["visible-login", "close-shared", "new-page:headless"]);
    assert.equal(result, freshPage);
    assert.match(result.url(), /yaanainc\.atlassian\.net/);
    assert.ok(notices.some((item) => item.status === "waiting_for_login"));
  });
});

test("openJiraSignedIn in headed mode waits on the same window until login completes", async () => {
  const session = { loggedIn: false };
  await withMockedAtlassian({ jira: statefulJira(session), login: LOGIN_HTML }, async (page) => {
    const saves = [];
    setTimeout(() => {
      session.loggedIn = true;
      page.goto(JIRA_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    }, 2500);

    const result = await openJiraSignedIn(page, "headed", () => {}, {
      authOptions: FAST_AUTH,
      deps: { saveJiraSession: async () => saves.push("save") },
    });

    assert.equal(result, page);
    assert.ok(saves.length >= 1);
  });
});

test("openJiraSignedIn reports an unknown login state instead of saving", async () => {
  await withMockedAtlassian({ jira: "<main>blank</main>", login: LOGIN_HTML }, async (page) => {
    let saved = 0;
    await assert.rejects(
      () =>
        openJiraSignedIn(page, "headless", () => {}, {
          authOptions: { timeoutMs: 1200, stableMs: 200 },
          deps: { saveJiraSession: async () => (saved += 1) },
        }),
      /Could not confirm that Jira is signed in/,
    );
    assert.equal(saved, 0);
  });
});

test("waitForManualLogin stops when the run is cancelled", async () => {
  await withMockedAtlassian({ jira: SHELL_HTML, login: LOGIN_HTML }, async (page) => {
    const controller = new AbortController();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    setTimeout(() => controller.abort(), 500);
    await assert.rejects(
      () =>
        waitForManualLogin(page, () => {}, {
          timeoutMs: 15000,
          pollMs: 100,
          signal: controller.signal,
          save: async () => {},
        }),
      (error) => error.code === "XRAY_WORKFLOW_CANCELLED",
    );
  });
});
