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
    res.end(JSON.stringify({ ResponseStatus: { Ack: "Success" }, cookie: req.headers.cookie ?? "" }));
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
    const html = await clients[0].vbkSessionGetText({ endpoint: `${origin}/model`, errorLabel: "native GET smoke" });
    assert.equal(JSON.parse(html.text).cookie, "test_account=a");
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log("PASS: actual Electron GET/POST cookies, concurrent partition isolation, zero renderer windows");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally { server.close(); }
});
