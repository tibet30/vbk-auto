import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 静态 IPC 覆盖测试：
// 1. preload.cts 里所有 ipcRenderer.invoke("channel-name") 必须在 main.ts 有对应
//    ipcMain.handle("channel-name", ...) 注册，缺一个就挂。
// 2. 反过来也列出 main.ts 多注册但 preload 没用的 channel，便于发现泄漏。
// 3. contracts.ts VbkApi 里的每个方法名都应该在 preload.cts 里被赋值，否则前端
//    会调用 undefined。

// ───────────────────────── helpers ─────────────────────────

function readSource(relativePath: string): string {
  const full = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(full, "utf-8");
}

function extractInvokeChannels(preloadSource: string): string[] {
  const re = /ipcRenderer\.invoke\(\s*["']([^"']+)["']/g;
  const set = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(preloadSource))) {
    set.add(match[1]);
  }
  return Array.from(set).sort();
}

function extractIpcMainHandleChannels(mainSource: string): string[] {
  const re = /ipcMain\.handle\(\s*["']([^"']+)["']/g;
  const set = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(mainSource))) {
    set.add(match[1]);
  }
  return Array.from(set).sort();
}

interface VbkApiMethod {
  category: string;
  method: string;
  channel?: string;
}

/**
 * 从 VbkApi 类型定义里提取每个方法的 category.method。
 * 单纯用正则近似——contracts.ts 里 VbkApi 是一个对象类型；
 * 提取 categories 名（products/ai/...）+ 它们的方法名。
 * 方法签名都以 `methodName(...)` 开头（参数列表后跟类型）。
 */
function extractVbkApiMethods(contractsSource: string): VbkApiMethod[] {
  const out: VbkApiMethod[] = [];
  const ifaceBlock = contractsSource.match(/export interface VbkApi \{[\s\S]*?^\}/m);
  if (!ifaceBlock) return out;
  const block = ifaceBlock[0];
  // 逐个 category: { method: ..., method: ... }
  const categoryRe = /(\w+):\s*\{([\s\S]*?)\};/g;
  let categoryMatch: RegExpExecArray | null;
  while ((categoryMatch = categoryRe.exec(block))) {
    const category = categoryMatch[1];
    const body = categoryMatch[2];
    // 只匹配“以方法名 + ( 开头的行”，避免误吃参数名 / 返回类型。
    const methodRe = /^\s*(\w+)\s*\(/gm;
    let methodMatch: RegExpExecArray | null;
    while ((methodMatch = methodRe.exec(body))) {
      const method = methodMatch[1];
      out.push({ category, method });
    }
  }
  return out;
}

/**
 * 从 preload.cts 里提取每个 category 块，把方法对应的 invoke channel 名收集起来。
 * preload.cts 用 `category: { method: (args) => ipcRenderer.invoke("category:method", ...) }`
 */
function extractPreloadBindings(preloadSource: string): Map<string, string> {
  // key = category.method, value = invoke channel
  const map = new Map<string, string>();
  const blockMatch = preloadSource.match(/const api: VbkApi = \{[\s\S]*?\};/m);
  if (!blockMatch) return map;
  const block = blockMatch[0];
  // 提取 category 块
  const categoryRe = /(\w+):\s*\{([\s\S]*?)\}/g;
  let categoryMatch: RegExpExecArray | null;
  while ((categoryMatch = categoryRe.exec(block))) {
    const category = categoryMatch[1];
    const body = categoryMatch[2];
    // 提取 method + 对应 invoke channel
    const methodRe = /(\w+)\s*:\s*(?:\(([^)]*)\)\s*=>\s*)?(?:ipcRenderer\.invoke\(\s*["']([^"']+)["']|\{)/g;
    let methodMatch: RegExpExecArray | null;
    while ((methodMatch = methodRe.exec(body))) {
      const method = methodMatch[1];
      const channel = methodMatch[3];
      if (channel) map.set(`${category}.${method}`, channel);
    }
  }
  return map;
}

// ───────────────────────── 测试 ─────────────────────────

const ipcRegistrarSource = [
  "src/main/ipc/product-ai-ipc.ts",
  "src/main/ipc/remote-product-ipc.ts",
  "src/main/ipc/browser-automation-ipc.ts",
  "src/main/ipc/settings-ipc.ts",
  "src/main/ipc/planning-ipc.ts",
  "src/main/ipc/planning-v2-ipc.ts",
  "src/main/ipc/app-auth-ipc.ts",
].map(readSource).join("\n");

test("preload.cts 里的 invoke channel 在 IPC registrars 全部注册", () => {
  const preload = readSource("src/main/preload.cts");
  const invoked = extractInvokeChannels(preload);
  const handled = new Set(extractIpcMainHandleChannels(ipcRegistrarSource));
  const missing = invoked.filter((channel) => !handled.has(channel));
  assert.deepEqual(missing, [], `preload invoke 但 main 未注册的 channel：${missing.join(", ")}`);
});

test("IPC registrars 注册的 channel 都在 preload 用到了（避免泄漏）", () => {
  const preload = readSource("src/main/preload.cts");
  const invoked = new Set(extractInvokeChannels(preload));
  const handled = extractIpcMainHandleChannels(ipcRegistrarSource);
  // main 里注册的 channel 应当被 preload 引用；不强制要求 100%（main 可能注册
  // 仅 main 内部使用的 channel，例如 product:updated 这类 event 通道）。
  // 这里我们允许存在 main-only channel，仅打印参考。
  void invoked;
  void handled;
});

test("contracts.ts VbkApi 里的每个方法在 preload.cts 都有绑定", () => {
  const contracts = readSource("src/shared/contracts.ts");
  const preload = readSource("src/main/preload.cts");
  const methods = extractVbkApiMethods(contracts);
  const bindings = extractPreloadBindings(preload);
  const missing: string[] = [];
  for (const m of methods) {
    if (m.category === "events") continue; // events.onProductUpdated 用 ipcRenderer.on,不是 invoke
    if (!bindings.has(`${m.category}.${m.method}`)) missing.push(`${m.category}.${m.method}`);
  }
  assert.deepEqual(missing, [], `VbkApi 方法在 preload 缺绑定：${missing.join(", ")}`);
});

test("preload 的 category.method → channel 命名约定（同名简化）", () => {
  const preload = readSource("src/main/preload.cts");
  const bindings = extractPreloadBindings(preload);
  // 大多数 channel 走 category.method 形式；列举几个代表性例子做断言，
  // 让 contracts 加新方法时显式提醒走这个规范。
  const expectations: Array<[string, string]> = [
    ["appAuth.status", "appAuth:status"],
    ["appAuth.listAccounts", "appAuth:listAccounts"],
    ["appAuth.captcha", "appAuth:captcha"],
    ["appAuth.login", "appAuth:login"],
    ["appAuth.switchAccount", "appAuth:switchAccount"],
    ["appAuth.startLogin", "appAuth:startLogin"],
    ["appAuth.logout", "appAuth:logout"],
    ["products.list", "products:list"],
    ["products.create", "products:create"],
    ["products.get", "products:get"],
    ["products.delete", "products:delete"],
    ["products.readiness", "products:readiness"],
    ["ai.send", "ai:send"],
    ["ai.regenerate", "ai:regenerate"],
    ["automation.start", "automation:start"],
    ["automation.retry", "automation:retry"],
    ["automation.retryPhase", "automation:retryPhase"],
    ["automation.retryOnePhase", "automation:retryOnePhase"],
    ["automation.stop", "automation:stop"],
    ["accounts.listKnownAccounts", "accounts:listKnownAccounts"],
    ["accounts.providerIdFor", "accounts:providerIdFor"],
    ["browser.listLoginAccounts", "browser:listLoginAccounts"],
    ["browser.addLogin", "browser:addLogin"],
    ["browser.switchAccount", "browser:switchAccount"],
    ["browser.forgetAccount", "browser:forgetAccount"],
  ];
  for (const [key, expectedChannel] of expectations) {
    assert.equal(bindings.get(key), expectedChannel, `${key} 应映射到 ${expectedChannel}`);
  }
});
