// Run after tsc: env -u ELECTRON_RUN_AS_NODE electron test/infrastructure/vbk-native-session-smoke.cjs
// Uses only synthetic cookies in non-persistent partitions and a loopback server.
const { app, session, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.end(JSON.stringify({ ResponseStatus: { Ack: "Success" }, cookie: req.headers.cookie ?? "", referrer: req.headers.referer ?? "", origin: req.headers.origin ?? "" }));
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { createVbkRequestPage } = await import(pathToFileURL(path.resolve("dist-electron/main/infrastructure/vbk-request-page.js")));
    const { vbkSessionRequest } = await import(pathToFileURL(path.resolve("dist-electron/main/infrastructure/vbk-session-request.js")));
    const clients = [];
    for (const account of ["a", "b"]) {
      const partition = session.fromPartition(`native-smoke-${account}-${Date.now()}`, { cache: false });
      await partition.cookies.set({ url: origin, name: "test_account", value: account });
      clients.push(createVbkRequestPage({ session: partition, assertActive: () => {},
        currentUrl: () => origin, interactivePage: async () => { throw new Error("Unexpected renderer acquisition"); } }));
    }
    const results = await Promise.all(clients.map(client => vbkSessionRequest(client, {
      endpoint: `${origin}/read`, body: {}, errorLabel: "native cookie smoke", browserRequestTimeoutMs: 5000, evaluateTimeoutMs: 6000,
    })));
    assert.equal(results[0].payload.cookie, "test_account=a");
    assert.equal(results[1].payload.cookie, "test_account=b");
    // Electron must honor a transient business Cookie header without writing it to the jar.
    const transient = session.fromPartition(`native-business-smoke-${Date.now()}`, { cache: false });
    await transient.cookies.set({ url: origin, name: "test_account", value: "original" });
    const business = await (await transient.fetch(`${origin}/read`, {
      method: "POST", credentials: "omit", headers: { cookie: "test_account=original; vbk-menu-business-id=1" },
    })).json();
    assert.equal(business.cookie, "test_account=original; vbk-menu-business-id=1");
    assert.equal((await transient.cookies.get({ url: origin })).some(cookie => cookie.name === "vbk-menu-business-id"), false);
    const crossOriginReferrer = `http://localhost:${server.address().port}/editor?productId=123`;
    const policyResult = await vbkSessionRequest(clients[0], {
      endpoint: `${origin}/read`, body: {}, errorLabel: "cross-origin referrer smoke",
      referrer: crossOriginReferrer, referrerPolicy: "strict-origin-when-cross-origin",
      browserRequestTimeoutMs: 5000, evaluateTimeoutMs: 6000,
    });
    assert.equal(policyResult.payload.referrer, `http://localhost:${server.address().port}/`);
    assert.equal(policyResult.payload.origin, "");
    const fullSource = await vbkSessionRequest(clients[0], {
      endpoint: `${origin}/read`, body: {}, errorLabel: "full source referrer smoke",
      referrer: crossOriginReferrer, referrerPolicy: "no-referrer-when-downgrade",
      browserRequestTimeoutMs: 5000, evaluateTimeoutMs: 6000,
    });
    assert.equal(fullSource.payload.referrer, crossOriginReferrer);
    assert.equal(fullSource.payload.origin, "");
    const html = await clients[0].vbkSessionGetText({ endpoint: `${origin}/model`, errorLabel: "native GET smoke" });
    assert.equal(JSON.parse(html.text).cookie, "test_account=a");
    // A restored session can be checked while its renderer remains about:blank.
    const { VbkBrowser } = await import(pathToFileURL(path.resolve("dist-electron/main/infrastructure/vbk-browser.js")));
    const cookies = ["vbkticket", "JSESSIONID", "GUID"].map(name => ({ name, value: "synthetic" }));
    let requests = 0;
    const view = { webContents: {
      id: 42, getURL: () => "about:blank", isDestroyed: () => false,
      executeJavaScript: () => { throw new Error("Unexpected renderer execution"); },
      loadURL: () => { throw new Error("Unexpected page navigation"); },
      session: { cookies: { get: async () => cookies }, fetch: async (_url, options) => {
        assert.equal(options.headers.origin, "https://vbooking.ctrip.com");
        requests += 1;
        return new Response(JSON.stringify({ ResponseStatus: { Ack: "Success" },
          user: { name: "测试账号", account: "vbk_test", partyId: 123 } }));
      } },
    } };
    const browser = Object.assign(Object.create(VbkBrowser.prototype), {
      initialiseState: "ready", accounts: new Map([["vbk_test", view]]), activeKey: "vbk_test",
    });
    assert.equal((await browser.status(true)).loggedIn, true);
    assert.equal(await browser.waitUntilReady(), true);
    assert.equal(requests, 2);
    view.webContents.session.fetch = async () => { throw new Error("Expired session"); };
    assert.equal((await browser.status(true)).loggedIn, false);
    assert.equal((await browser.status()).loggedIn, false);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log("PASS: actual Electron GET/POST cookies, partition isolation, blank-page login and expired-session rejection, zero renderer windows");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally { server.close(); }
});
