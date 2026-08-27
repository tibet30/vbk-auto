import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("主窗口在加载 renderer 前发布 browser / automation 服务", () => {
  const source = readFileSync(new URL("../../src/main/create-window.ts", import.meta.url), "utf8");
  const publish = source.indexOf("args.onServicesCreated?.(services)");
  const rendererLoad = source.indexOf("window.loadURL(devRendererUrl)");
  const defaultRendererUrl = source.indexOf('"http://127.0.0.1:5173"');
  assert.ok(publish >= 0, "必须显式发布窗口服务");
  assert.ok(rendererLoad >= 0, "必须保留开发 renderer 加载入口");
  assert.ok(defaultRendererUrl >= 0, "必须保留默认 Vite renderer 地址");
  assert.ok(publish < rendererLoad, "renderer 首次 IPC 前 browser / automation 必须已注入 context");
});

test("renderer 首次加载不等待远端 VBK initialise", () => {
  const source = readFileSync(new URL("../../src/main/create-window.ts", import.meta.url), "utf8");
  const rendererLoad = source.indexOf("const rendererReady =");
  const initialise = source.indexOf("browser.initialise()");
  const rendererAwait = source.indexOf("await rendererReady");
  assert.ok(initialise >= 0, "必须保留 VBK initialise");
  assert.ok(rendererLoad >= 0, "必须先创建 renderer 加载任务");
  assert.ok(rendererLoad < initialise, "本地 renderer 必须先于远端 VBK 初始化开始加载");
  assert.ok(rendererAwait > initialise, "只能等待 renderer 首屏，不能等待远端 VBK");
  assert.match(source, /\? window\.loadURL\(devRendererUrl\)[\s\S]*: window\.loadFile\(/, "必须保留开发和生产 renderer 入口");
  assert.doesNotMatch(source, /await\s+browser\.initialise\(\)/, "renderer 创建不能 await 远端 VBK initialise");
  assert.match(
    source.slice(initialise),
    /Promise\.all\(\[rendererReady, browserReady\]\)[\s\S]*\.catch\(/,
    "后台 initialise 必须显式兜底，不能产生未处理 rejection",
  );
});
