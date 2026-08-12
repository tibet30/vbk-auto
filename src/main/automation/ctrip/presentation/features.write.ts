// @ts-nocheck
/**
 * 「产品特色」写入 + 回读 + 重试 helper：
 *   - writeToEditor：把 value 写入目标编辑器；iframe body 走 frame.evaluate + UEditor
 *     setContent/sync 同步 hidden textarea；
 *   - readFromEditor：回读编辑器当前值；UEditor 同步后三件套：body.innerText / hidden.value / editor.getContent()；
 *   - retryWrite：readback 不匹配时再触发一次写入；
 *   - normalize / readbackIncludes：归一化字符串 + 三件套联合校验；
 *   - trySyncReactState：iframe-body 写入完成后调用 React onChange 把目标 HTML 灌进 React store，
 *     验证 editproductDesc 同步命中；无 React / 找不到 onChange 时返回 synced=false 不抛错。
 *
 * 顶部带 `// @ts-nocheck`，因为 page / locator 类型是动态传入。
 */

import type { EditorTarget } from "./features.types.js";
import { delay } from "../utils.js";
import { syncReactStateForTarget, type ReactSyncOutcome } from "./features.react-sync.js";

/**
 * 把 value 写入目标编辑器：
 *   - iframe body 走 frame.evaluate 清空 + 写入 + 触发 input/change/keyup 事件
 *     （ueditor / wangEditor 都依赖这些事件同步 onChange）；
 *   - textarea / input / contenteditable 走 fill（Playwright 触发原生 input 事件）。
 * 写入前会等目标可见 / 可编辑。
 *
 * 返回 ueditorUsed（iframe-body 命中了 window.parent.UE?.instants 同源实例时为 true）。
 */
async function writeToEditor(target: EditorTarget, value: string): Promise<boolean> {
  if (target.type === "iframe-body") {
    // UEditor owns the iframe body.  Use only the exact same-origin instance; never
    // scan arbitrary editors or rely on blur to synchronize its hidden textarea.
    const result = await target.locator.evaluate((body: HTMLElement | null, text: string) => {
      if (!body) return { ok: false, ueditor: false };
      const parentWindow = window.parent;
      const instants = (parentWindow as any)?.UE?.instants;
      const editor = instants && Object.values(instants).find((candidate: any) => candidate?.body === body) as any;
      const lines = String(text || "").split(/\n/);
      const escaped = lines.map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;")).join("<br>");
      if (editor) {
        editor.setContent(escaped);
        editor.sync();
        return { ok: true, ueditor: true };
      }
      body.focus();
      body.innerHTML = "";
      for (let i = 0; i < lines.length; i += 1) {
        if (i > 0) body.appendChild(document.createElement("br"));
        body.appendChild(document.createTextNode(lines[i]!));
      }
      body.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      body.dispatchEvent(new Event("change", { bubbles: true }));
      body.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      return { ok: true, ueditor: false };
    }, value);
    if (!result?.ok) throw new Error("iframe body 不可写");
    return Boolean(result.ueditor);
  }
  await target.locator.waitFor({ state: "visible", timeout: 3_000 });
  if (!(await target.locator.isEditable().catch(() => false))) throw new Error("目标编辑器不可编辑");
  await target.locator.fill(value);
  return false;
}

/**
 * 回读编辑器当前值：iframe body 走 innerText；contenteditable 走 innerText；其他走 inputValue。
 * 容忍 undefined 返回，便于 mock。
 */
async function readFromEditor(target: EditorTarget): Promise<any> {
  if (target.type === "iframe-body") {
    return await target.locator.evaluate((body: HTMLElement | null) => {
      const editor = Object.values((window.parent as any)?.UE?.instants || {})
        .find((candidate: any) => candidate?.body === body) as any;
      const bodyText = body?.innerText || "";
      if (!editor) return { bodyText, hiddenText: "", ueditor: false };
      const name = editor.options?.textarea;
      const hidden = name ? Array.from(window.parent.document.getElementsByName(name)).find((node: any) => node instanceof window.parent.HTMLTextAreaElement) as HTMLTextAreaElement | undefined : undefined;
      return { bodyText, hiddenText: hidden?.value || "", ueditor: true, content: editor.getContent?.() || "" };
    }).catch(() => ({ bodyText: "", hiddenText: "", ueditor: false }));
  }
  if (target.type === "contenteditable") return ((await target.locator.innerText().catch(() => "")) as string) || "";
  return ((await target.locator.inputValue().catch(() => "")) as string) || "";
}

/**
 * 归一化字符串（去空白 / 全角空格），用于回读校验。
 */
function normalize(value: string): string {
  return String(value || "").replace(/\s+/g, "").replace(/　/g, "");
}

function readbackIncludes(readback: any, value: string): boolean {
  const expected = normalize(value);
  if (readback && typeof readback === "object") {
    const body = normalize(readback.bodyText);
    if (readback.ueditor) {
      return body.includes(expected) && normalize(readback.hiddenText).includes(expected) && normalize(readback.content).includes(expected);
    }
    return body.includes(expected);
  }
  return normalize(readback).includes(expected);
}

/**
 * 在候选作用域上重试一次写入：用于 readback 与目标不匹配时，再触发一次 fill 强制同步。
 */
async function retryWrite(target: EditorTarget, value: string) {
  if (target.type === "iframe-body") {
    await writeToEditor(target, value);
    return;
  }
  await target.locator.fill("");
  await delay(50);
  await target.locator.fill(value);
}

/**
 * 对 iframe-body 写入结果尝试触发 React 状态同步：
 *   - 内部直接转发到 syncReactStateForTarget：非 iframe-body（textarea / input /
 *     contenteditable）由 syncReactStateForTarget 返回 synced=false + 空 diagnostic
 *     + reactDetected=false（向后兼容，不阻断保存）；
 *   - iframe-body 才会真正执行 fiber 查找 + onChange 调用 + 祖先 state 校验；
 *   - 永远不抛错；调用方根据 synced + reactDetected 决定是否阻断保存。
 *
 * 这里签名固定为 (target, value, page) 便于 fillProductFeatures 串行调用，
 * 并保留 features.write.ts 这个 barrel 调用面，避免 features.ts 跨文件依赖
 * features.react-sync.ts 的具体入口（layered 模块边界）。
 */
async function trySyncReactState(target: EditorTarget, value: string, page: any): Promise<ReactSyncOutcome> {
  return syncReactStateForTarget(target, value, page);
}

export {
  normalize,
  readbackIncludes,
  readFromEditor,
  retryWrite,
  trySyncReactState,
  writeToEditor,
};