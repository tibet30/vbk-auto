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
