// After tsc: env -u ELECTRON_RUN_AS_NODE electron test/infrastructure/manual-cover-native-smoke.cjs
// All requests are redirected by this test wrapper to a loopback server.
const { app, session, BrowserWindow } = require("electron");
const http = require("node:http");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
app.whenReady().then(async () => {
  const events = [];
  const bound = new Map();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=", "base64");
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const account = req.headers.cookie;
      assert.ok(["account=a", "account=b"].includes(account));
      events.push({ account, url: req.url });
      let payload = { ResponseStatus: { Ack: "Success" } };
      if (req.url.includes("suggestdistrict")) payload.districtDtos = [{ name: "泸州", id: 604, countryId: 1 }];
      if (req.url.includes("uploadImage")) {
        assert.deepEqual(Buffer.from(body.body[0].fileBytes, "base64"), bytes);
        assert.equal(body.body[0].source, 1);
        payload.body = [{ success: true, imageId: account === "account=a" ? 123 : 456 }];
      }
      if (req.url.includes("bindProductImage")) {
        bound.set(account, body.productImages[0].imageId);
        payload.success = true;
      }
      if (req.url.includes("searchProductImage")) payload.productImages = bound.has(account)
        ? [{ imageInfo: { imageId: bound.get(account), accompanyTourInfo: { imageTypeId: 2 } } }] : [];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ message: error.message })); }
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const load = file => import(pathToFileURL(path.resolve(`dist-electron/main/${file}.js`)));
    const { createVbkRequestPage } = await load("infrastructure/vbk-request-page");
    const { uploadManualCoverViaSupplierPage } = await load("automation/ctrip/presentation/manual-cover-upload");
    const results = [];
    for (const account of ["a", "b"]) {
      const ses = session.fromPartition(`upload-smoke-${account}-${Date.now()}`, { cache: false });
      await ses.cookies.set({ url: origin, name: "account", value: account });
      const client = createVbkRequestPage({ session: ses, assertActive() {}, currentUrl: () => "about:blank",
        interactivePage: async () => { throw new Error("Unexpected renderer acquisition"); } });
      const nativeFetch = client.vbkSessionFetch;
      client.vbkSessionFetch = req => nativeFetch({ ...req,
        endpoint: `${origin}${new URL(req.endpoint).pathname}`, referrer: origin });
      let saved = 0;
      results.push(await uploadManualCoverViaSupplierPage(client, 42,
        { name: "cover.png", mimeType: "image/png", buffer: bytes }, "泸州", undefined,
        id => { assert.equal(bound.has(`account=${account}`), false); saved = id; }));
      assert.equal(saved, account === "a" ? 123 : 456);
    }
    assert.deepEqual(results.map(result => result.imageId), [123, 456]);
    assert.equal(events.filter(e => e.url.includes("uploadImage")).length, 2);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log("PASS: native image bytes, two isolated account sessions, checkpoint before binding, unique-cover readback, zero renderer windows");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { server.close(); }
});
