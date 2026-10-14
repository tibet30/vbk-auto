import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { _electron as electron } from "playwright";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);

test("页面弹窗遮挡真实原生 VBK 视图，更新、酒店和重生成确认关闭后恢复", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vbk-update-browser-"));
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react()],
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await server.listen();
    const preload = transformSync(await readFile("src/main/preload.cts", "utf8"), {
      loader: "ts", format: "cjs", target: "es2022",
    }).code;
    await writeFile(path.join(directory, "preload.cjs"), preload);
    // 生产 preload、React 弹窗、可见性 hook 和原生视图管理器；仅更新服务和 VBK 页面使用隔离数据。
    await writeFile(path.join(directory, "main.cjs"), `
      const {app,BrowserWindow,ipcMain,session}=require('electron');
      require(${JSON.stringify(require.resolve("tsx/cjs"))});
      const {VbkBrowserViewManager}=require(${JSON.stringify(path.resolve("src/main/infrastructure/vbk-browser-view-manager.ts"))});
      app.setPath('userData',${JSON.stringify(path.join(directory, "user-data"))});
      global.updateBrowserNativeReady=app.whenReady().then(async()=>{
        const win=new BrowserWindow({width:1200,height:850,show:false,webPreferences:{preload:__dirname+'/preload.cjs'}});
        const blockExternal=(details,callback)=>callback({cancel:!details.url.startsWith('http://127.0.0.1:')&&!details.url.startsWith('ws://127.0.0.1:')&&!details.url.startsWith('data:')});
        session.defaultSession.webRequest.onBeforeRequest(blockExternal);
        const views=new VbkBrowserViewManager(win,undefined,async()=>{throw Error('No external page')},()=>{throw Error('No blank page navigation')});
        const makeView=async(key)=>{
          const view=views.createView('isolated-update-'+key);
          view.webContents.session.webRequest.onBeforeRequest(blockExternal);
          await view.webContents.loadURL('data:text/html,<body style="background:lightblue;font-size:32px">VBK isolated page '+key+'</body>');
          return view;
        };
        views.defaultView=await makeView('default'); views.activateView(views.defaultView);
        ipcMain.handle('browser:setBounds',(_event,bounds)=>views.setBounds(bounds));
        ipcMain.handle('browser:setVisible',(_event,visible)=>views.setVisible(visible));
        let delayOverlay=false,acknowledgeOverlay;
        ipcMain.handle('browser:setOverlayOpen',(_event,open)=>{
          views.setOverlayOpen(open);
          if(open&&delayOverlay){delayOverlay=false;return new Promise(resolve=>{acknowledgeOverlay=resolve;});}
        });
        ipcMain.handle('browser:currentUrl',()=>views.currentUrl());
        let state={currentVersion:'1.1.15',availableVersion:'1.1.16',platform:'darwin',supported:true,feedUrl:'isolated',status:'available',updateAvailable:true,downloaded:false};
        const emit=(patch)=>{state={...state,...patch};win.webContents.send('updates:changed',state);return state;};
        let finishDownload;
        ipcMain.handle('updates:status',()=>state);
        ipcMain.handle('updates:download',()=>{
          emit({status:'downloading',progress:{percent:25,transferred:25,total:100}});
          return new Promise(resolve=>{finishDownload=()=>resolve(emit({status:'downloaded',downloaded:true}));});
        });
        global.updateBrowserNative={views,win,emit,makeView,finishDownload:()=>finishDownload(),
          delayNextOverlay:()=>{delayOverlay=true;},releaseOverlay:()=>{acknowledgeOverlay();acknowledgeOverlay=undefined;},
          snapshot:()=>({visible:views.visible,nativeVisible:views.view.getVisible(),url:views.currentUrl(),id:views.view.webContents.id,pendingOverlay:Boolean(acknowledgeOverlay)})};
        await win.loadURL(${JSON.stringify(`${server.resolvedUrls!.local[0]}test/fixtures/app-update-browser-ui/index.html`)});
      });
      app.on('window-all-closed',()=>app.quit());
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await electron.launch({ args: [path.join(directory, "main.cjs")], env });
    await desktop.evaluate(async () => { await (globalThis as any).updateBrowserNativeReady; });
    // 回归窗口必须保持隐藏：它渲染的是真实 App 外壳，一旦可见就会在开发机桌面
    // 弹出「App 一闪即关」的假象（历史问题）。capturePage 依赖 paintWhenInitiallyHidden。
    assert.deepEqual(
      await desktop.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => win.isVisible())),
      [false],
      "测试窗口不得可见",
    );
    const page = desktop.windows().find(page => page.url().startsWith(server.resolvedUrls!.local[0]))!;
    assert.ok(page, "选择应用页面，而不是原生 VBK 子视图");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const snapshot = () => desktop!.evaluate(() => (globalThis as any).updateBrowserNative.snapshot());
    const expectVisible = async (visible: boolean) => {
      await page.waitForFunction(async expected => {
        // IPC barrier：等待前面的可见性消息处理完毕。
        await window.vbk.browser.currentUrl();
        return expected === Boolean(document.querySelector("dialog:modal"));
      }, !visible);
      const current = await desktop!.evaluate(async (_electron, expected) => {
        const native = (globalThis as any).updateBrowserNative;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const state = native.snapshot();
          if (state.visible === expected && state.nativeVisible === expected) return state;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return native.snapshot();
      }, visible);
      assert.equal(current.visible, visible);
      assert.equal(current.nativeVisible, visible);
      return current;
    };
    await page.getByRole("button", { name: "下载与更新", exact: true }).waitFor({ timeout: 10000 }).catch(error => {
      throw new Error(`${error.message}\nURL: ${page.url()}\n${errors.join("\n")}`);
    });
    const original = await expectVisible(true);
    assert.equal(original.nativeVisible, true);
    const open = () => page.getByRole("button", { name: "下载与更新", exact: true }).click();
    const dialog = page.locator('dialog[aria-labelledby="app-update-dialog-title"]');
    await open();
    await expectVisible(false);
    assert.equal(await dialog.getByRole("button", { name: "关闭更新说明" }).evaluate(node => node === document.activeElement), true);
    // 自动任务再次要求显示、切换账号的原生视图都不能绕过弹窗遮挡。
    await desktop.evaluate(async () => {
      const native = (globalThis as any).updateBrowserNative;
      native.views.setVisible(true);
      const next = await native.makeView("account");
      native.views.accounts.set("account", next);
      native.views.activateView(next, "account");
    });
    const account = await expectVisible(false);
    await mkdir("output/playwright/app-update-browser", { recursive: true });
    const image = await desktop.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
    await writeFile("output/playwright/app-update-browser/hidden.png", Buffer.from(image, "base64"));
    await page.keyboard.press("Escape");
    const restored = await expectVisible(true);
    assert.equal(restored.url, account.url);
    assert.equal(restored.id, account.id);
    assert.notEqual(restored.id, original.id);
    const hotelOpen = page.getByRole("button", { name: "酒店草稿确认", exact: true });
    const hotelDialog = page.getByRole("dialog", { name: "仅保存酒店规则草稿", exact: true });
    await hotelOpen.click();
    await hotelDialog.waitFor();
    await expectVisible(false);
    await hotelDialog.evaluate(dialog => Promise.all(dialog.getAnimations().map(animation => animation.finished)));
    const hotelImage = await desktop.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
    await writeFile("output/playwright/app-update-browser/hotel-hidden.png", Buffer.from(hotelImage, "base64"));
    await page.keyboard.press("Escape");
    await expectVisible(true);
    assert.equal(await page.getByLabel("酒店确认结果").innerText(), "false");
    await hotelOpen.click();
    await hotelDialog.getByRole("button", { name: "仅保存酒店草稿", exact: true }).click();
    await expectVisible(true);
    assert.equal(await page.getByLabel("酒店确认结果").innerText(), "true");
    await page.getByRole("button", { name: "重生成确认", exact: true }).click();
    await page.getByRole("dialog", { name: "重做“基础方案”", exact: true }).waitFor();
    await expectVisible(false);
    await page.keyboard.press("Escape");
    await expectVisible(true);
    // 重叠弹窗必须全部关闭后才恢复，不能由更新弹窗提前解除遮挡。
    await open();
    await page.evaluate(() => {
      const modal = document.createElement("dialog"); modal.id = "second-modal";
      document.body.append(modal); modal.showModal();
      (window as any).updateBrowserFixture.closeDialog();
    });
    await dialog.waitFor({ state: "hidden" });
    await expectVisible(false);
    await page.evaluate(() => {
      const modal = document.getElementById("second-modal") as HTMLDialogElement;
      modal.close(); modal.remove();
    });
    await expectVisible(true);
    // 隐藏原生视图的异步回执迟到时，已取消的弹窗不能重新弹出。
    await desktop.evaluate(() => (globalThis as any).updateBrowserNative.delayNextOverlay());
    await open();
    await desktop.evaluate(async () => {
      const native = (globalThis as any).updateBrowserNative;
      const deadline = Date.now() + 5000;
      while (!native.snapshot().pendingOverlay && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!native.snapshot().pendingOverlay) throw new Error("延迟隐藏回执未发生");
    });
    await page.evaluate(() => (window as any).updateBrowserFixture.closeDialog());
    await desktop.evaluate(() => (globalThis as any).updateBrowserNative.releaseOverlay());
    await expectVisible(true);
    await open();
    await dialog.getByRole("button", { name: "下载新版", exact: true }).click();
    await dialog.getByRole("progressbar").waitFor();
    await expectVisible(false);
    await dialog.getByRole("button", { name: "后台下载", exact: true }).click();
    await expectVisible(true);
    await open();
    await desktop.evaluate(() => (globalThis as any).updateBrowserNative.finishDownload());
    await dialog.getByRole("button", { name: "打开安装包", exact: true }).waitFor();
    await expectVisible(false);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expectVisible(true);
    // 关闭时若已切离工作区或浏览器阶段，不能强制重新显示原生视图。
    for (const change of ["view", "mount"] as const) {
      await open();
      await page.evaluate(change => {
        const fixture = (window as any).updateBrowserFixture;
        if (change === "view") fixture.setView("settings"); else fixture.setMounted(false);
      }, change);
      await expectVisible(false);
      await dialog.getByRole("button", { name: "关闭更新说明" }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.evaluate(() => window.vbk.browser.currentUrl());
      assert.equal((await snapshot()).nativeVisible, false);
      await page.evaluate(() => {
        const fixture = (window as any).updateBrowserFixture;
        fixture.setView("workspace"); fixture.setMounted(true);
      });
      await expectVisible(true);
    }
    assert.deepEqual(errors, []);
  } finally {
    await desktop?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
