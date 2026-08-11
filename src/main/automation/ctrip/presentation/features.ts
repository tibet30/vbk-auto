// @ts-nocheck
/**
 * 「产品特色」富文本编辑器定位与写入 helper：
 *   - findFeaturesFormItem：用可见「产品特色」/「产品特点」label 反查最近的 .ant-form-item 容器；
 *   - findFeaturesFallbackContainers：依次尝试 #briefeditor / #pm_features 可见 fallback 容器
 *     （新旧两套 DOM 都覆盖，priority chain）；
 *   - findEditorInScope：在容器作用域内按 textarea > input > [contenteditable] > iframe body
 *     顺位挑选；iframe 候选会校验 body 可写（contenteditable / isContentEditable），
 *     避免命中隐藏的 _ueditor 同步框等不可写 iframe；
 *   - writeToEditor：统一封装 fill / iframe body 写入 + 等待可交互；
 *   - readFromEditor：回读当前编辑器内容，用于「写入后回读校验」；
 *   - fillProductFeatures：顶层入口；先 label 锚点 → 再有限度 fallback 链 → 写入后回读；
 *     失败抛「找不到产品特点富文本输入框」并附诊断，绝不静默保存。
 *
 * 顶部带 `// @ts-nocheck`，因为 page / locator 类型是动态传入。
 *
 * 历史（DOM 演进，按真实 Electron CDP 探测结果）：
 *   - VBK 老版文案：「产品特点」label + #pm_features 容器 + 普通 textarea；
 *   - VBK 新版（productImageText?productId=76906037）：「产品特色」label +
 *     #briefeditor 容器 + UEditor iframe #ueditor_0；
 *   - 同时支持两套 DOM，避免维护两套实现；label 关键词与 fallback 容器都按优先级链处理。
 */

import { delay } from "../utils.js";

/** 「产品特色」/「产品特点」label 关键词优先级：VBK 新版在前，老版兜底。 */
const LABEL_KEYWORDS = ["产品特色", "产品特点"] as const;
/** 有限度 fallback 容器优先级：#briefeditor（VBK 新版）先，#pm_features（老版）兜底。 */
const FEATURES_FALLBACK_CONTAINERS = ["#briefeditor", "#pm_features"] as const;
/** 写入后回读等待时间（ms），给 React / ueditor 触发 onChange 留缓冲。 */
const READBACK_DEADLINE_MS = 2_500;

// 向后兼容旧单值导出：保留 LABEL_KEYWORD / FEATURES_FALLBACK_CONTAINER 给历史消费者
// （不参与实现逻辑，仅做 API 兼容）。新逻辑使用上面的 array 常量。
const LABEL_KEYWORD: string = "产品特点";
const FEATURES_FALLBACK_CONTAINER: string = "#pm_features";

export type FeaturesEditorType = "textarea" | "input" | "contenteditable" | "iframe-body";
export type FeaturesScopeSource = "label" | "fallback";

export interface FeaturesResult {
  filled: boolean;
  diagnostic: string;
  editorType?: FeaturesEditorType;
  scopeSource?: FeaturesScopeSource;
}

interface LabelScope {
  scope: any;
  source: "label";
  matchedKeyword: string;
}

interface FallbackScope {
  scope: any;
  source: "fallback";
  containerId: string;
}

type AnyScope = LabelScope | FallbackScope;

interface EditorTarget {
  locator: any;
  type: FeaturesEditorType;
  frame?: any;
}

/**
 * 在页面上找可见的「产品特色」/「产品特点」label，并向上反查最近 .ant-form-item 容器：
 *   - 优先 label[for*="features" i]（精确 id 命中时最稳，匹配 for="brief_features" 等）；
 *   - 再回退到任意含「产品特色」/「产品特点」文本的 label（覆盖 ant-form-item-label 包裹层）；
 *   - 找不到或可见性 / 容器数异常时返回 null，让 fillProductFeatures 走 fallback。
 */
async function findFeaturesFormItem(page): Promise<LabelScope | null> {
  // 顺序：for* 精确匹配（任意 label 文本）→ 文本关键词（按优先级遍历）。每条候选内的
  // label 都按可见性 + .ant-form-item 唯一性筛选；任一命中即返回。
  const candidates: Array<{ labels: any; matchedKeyword: string }> = [
    { labels: page.locator('label[for*="features" i]'), matchedKeyword: "for*='features'" },
  ];
  for (const keyword of LABEL_KEYWORDS) {
    candidates.push({
      labels: page.locator("label").filter({ hasText: keyword }),
      matchedKeyword: keyword,
    });
  }
  for (const { labels, matchedKeyword } of candidates) {
    const count = await labels.count();
    for (let i = 0; i < count; i += 1) {
      const label = labels.nth(i);
      if (!(await label.isVisible().catch(() => false))) continue;
      const formItem = label.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]",
      );
      if ((await formItem.count()) !== 1) continue;
      const item = formItem.first();
      if (!(await item.isVisible().catch(() => false))) continue;
      return { scope: item, source: "label", matchedKeyword };
    }
  }
  return null;
}

/**
 * 有限度 fallback：依次尝试可见且唯一的 #briefeditor / #pm_features 容器。
 * 必须 count=1 + 可见，否则跳过；返回所有可用候选（按优先级排序）。
 * 严禁全页 scan：每个容器都用具体 ID 锚定。
 */
async function findFeaturesFallbackContainers(page): Promise<FallbackScope[]> {
  const result: FallbackScope[] = [];
  for (const containerId of FEATURES_FALLBACK_CONTAINERS) {
    const container = page.locator(containerId);
    const count = await container.count();
    if (count !== 1) continue;
    const item = container.first();
    if (!(await item.isVisible().catch(() => false))) continue;
    result.push({ scope: item, source: "fallback", containerId });
  }
  return result;
}

/**
 * 把 scope 的可读信息压平成诊断用字符串（label ↦ 匹配关键词；fallback ↦ 容器 ID）。
 */
function describeScope(resolved: AnyScope): string {
  if (resolved.source === "label") {
    return `label 锚定的 .ant-form-item（匹配：${resolved.matchedKeyword}）`;
  }
  return `${resolved.containerId} fallback 容器`;
}

/**
 * 在容器作用域内按顺位挑选第一个可用编辑器：
 *   - textarea > input[type="text"] > [contenteditable="true"] > iframe(body)；
 *   - iframe 候选额外校验 body 可写（contenteditable / isContentEditable），跳过不可写 iframe
 *     （避免命中隐藏的 _ueditor 同步框、广告 iframe 等）；
 *   - 多候选取第一个可见 / 可写的（绝不允许全页 scan）；
 *   - 找不到返回 null，由 fillProductFeatures 决定如何报错。
 */
async function findEditorInScope(scope): Promise<EditorTarget | null> {
  // textarea
  const textareas = scope.locator('textarea:visible:not([disabled]):not([readonly])');
  for (let i = 0; i < (await textareas.count()); i += 1) {
    const node = textareas.nth(i);
    if (await node.isEditable().catch(() => false)) {
      return { locator: node, type: "textarea" };
    }
  }
  // input[type="text"]
  const inputs = scope.locator('input[type="text"]:visible:not([disabled]):not([readonly])');
  for (let i = 0; i < (await inputs.count()); i += 1) {
    const node = inputs.nth(i);
    if (await node.isEditable().catch(() => false)) {
      return { locator: node, type: "input" };
    }
  }
  // [contenteditable="true"]：多候选取第一个可见的
  const editables = scope.locator('[contenteditable="true"]:visible');
  for (let i = 0; i < (await editables.count()); i += 1) {
    const node = editables.nth(i);
    if (await node.isEditable().catch(() => true)) {
      return { locator: node, type: "contenteditable" };
    }
  }
  // iframe body（ueditor / wangEditor 等富文本编辑器常见形态）：
  //   - 必须可见，且 body 必须可写（contenteditable / isContentEditable）；
  //   - Locator.contentFrame() 在新版本 Playwright 是同步的，返回 FrameLocator；
  //     旧版本是 Promise<Frame|null>；两种都兼容。
  const iframes = scope.locator("iframe:visible");
  for (let i = 0; i < (await iframes.count()); i += 1) {
    const node = iframes.nth(i);
    let frameLocator: any = null;
    try {
      const result = node.contentFrame();
      frameLocator =
        result && typeof (result as any).then === "function"
          ? await (result as Promise<any>).catch(() => null)
          : result;
    } catch {
      frameLocator = null;
    }
    if (!frameLocator) continue;
    const body = frameLocator.locator("body");
    // 校验 body 真正可写：避免命中隐藏 _ueditor / sync textarea 等不可写 iframe
    const writable = await body
      .evaluate((el: HTMLElement | null) => {
        if (!el) return false;
        if ((el as any).isContentEditable === true) return true;
        const ce = (el.getAttribute("contenteditable") || "").toLowerCase();
        if (ce === "true" || ce === "") return true;
        return false;
      })
      .catch(() => false);
    if (!writable) continue;
    // FrameLocator 提供 locator(...) / evaluate(...) / 等能力，足以完成写入与回读
    return { locator: body, frame: frameLocator, type: "iframe-body" };
  }
  return null;
}

/**
 * 把 value 写入目标编辑器：
 *   - iframe body 走 frame.evaluate 清空 + 写入 + 触发 input/change/keyup 事件
 *     （ueditor / wangEditor 都依赖这些事件同步 onChange）；
 *   - textarea / input / contenteditable 走 fill（Playwright 触发原生 input 事件）。
 * 写入前会等目标可见 / 可编辑。
 */
async function writeToEditor(target: EditorTarget, value: string) {
  if (target.type === "iframe-body") {
    // target.locator 已经是 frame.locator("body")，可以直接在 iframe 子文档上 evaluate。
    const ok = await target.locator.evaluate((body: HTMLElement | null, text: string) => {
      if (!body) return false;
      body.focus();
      body.innerHTML = "";
      const lines = String(text || "").split(/\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (i > 0) body.appendChild(document.createElement("br"));
        body.appendChild(document.createTextNode(lines[i]!));
      }
      body.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
      );
      body.dispatchEvent(new Event("change", { bubbles: true }));
      body.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      return true;
    }, value);
    if (!ok) throw new Error("iframe body 不可写");
    return;
  }
  await target.locator.waitFor({ state: "visible", timeout: 3_000 });
  if (!(await target.locator.isEditable().catch(() => false))) {
    throw new Error("目标编辑器不可编辑");
  }
  await target.locator.fill(value);
}

/**
 * 回读编辑器当前值：iframe body 走 innerText；contenteditable 走 innerText；其他走 inputValue。
 * 容忍 undefined 返回，便于 mock。
 */
async function readFromEditor(target: EditorTarget): Promise<string> {
  if (target.type === "iframe-body") {
    return (
      ((await target.locator
        .evaluate((body: HTMLElement | null) => body?.innerText || "")
        .catch(() => "")) as string) || ""
    );
  }
  if (target.type === "contenteditable") {
    return ((await target.locator.innerText().catch(() => "")) as string) || "";
  }
  return ((await target.locator.inputValue().catch(() => "")) as string) || "";
}

/**
 * 归一化字符串（去空白 / 全角空格），用于回读校验。
 */
function normalize(value: string): string {
  return String(value || "").replace(/\s+/g, "").replace(/　/g, "");
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
 * 「产品特色」顶层入口：
 *   1) 先用可见「产品特色」/「产品特点」label 锚定 .ant-form-item 容器（优先级链遍历）；
 *   2) label 锚点失败或容器内无编辑器时，按优先级尝试 #briefeditor / #pm_features fallback；
 *   3) 在容器作用域内顺位挑 textarea / input / contenteditable / iframe body（iframe 校验
 *      body 可写），不允许全页 scan；
 *   4) 写入后回读校验文本已存在；
 *   5) 失败抛「找不到产品特点富文本输入框」并附诊断（不静默保存）。
 */
export async function fillProductFeatures(page, value: string): Promise<FeaturesResult> {
  const valueSample = String(value ?? "");
  if (!valueSample.trim()) {
    return { filled: false, diagnostic: "presentation.features 为空，无需写入" };
  }

  // 优先级链：label 锚点（1 个） → fallback 容器（0~2 个）。label 失败时仍追加 fallback；
  // fallback 内部已经按 #briefeditor → #pm_features 顺序排列。
  const labelScope = await findFeaturesFormItem(page);
  const fallbackScopes = labelScope ? [] : await findFeaturesFallbackContainers(page);
  const orderedScopes: AnyScope[] = [
    ...(labelScope ? [labelScope] : []),
    ...fallbackScopes,
  ];

  // label 命中但其作用域内无编辑器时，仍要尝试 fallback，因此把 fallback 都纳入作用域列表。
  // 这里需要再补一次 fallback（label 命中但容器内编辑器不可用）。
  if (labelScope) {
    const moreFallbacks = await findFeaturesFallbackContainers(page);
    for (const fb of moreFallbacks) orderedScopes.push(fb);
  }

  const diagnostic: string[] = [];

  for (const resolved of orderedScopes) {
    const target = await findEditorInScope(resolved.scope);
    if (!target) {
      diagnostic.push(
        `${describeScope(resolved)} 内无 textarea/input/contenteditable/iframe 编辑器`,
      );
      continue;
    }
    try {
      await writeToEditor(target, valueSample);
    } catch (error) {
      diagnostic.push(
        `${describeScope(resolved)} 写入失败(${target.type})：${(error as Error).message}`,
      );
      continue;
    }
    // 回读校验：容忍 React / ueditor 异步触发，最多等 READBACK_DEADLINE_MS。
    const deadline = Date.now() + READBACK_DEADLINE_MS;
    let readback = await readFromEditor(target);
    let success = normalize(readback).includes(normalize(valueSample));
    while (!success && Date.now() < deadline) {
      await delay(120);
      readback = await readFromEditor(target);
      success = normalize(readback).includes(normalize(valueSample));
    }
    if (success) {
      return {
        filled: true,
        diagnostic: "",
        editorType: target.type,
        scopeSource: resolved.source,
      };
    }
    // 一次 retry：清空再写一次，覆盖 React 受控组件首次未触发 onChange 的情况
    try {
      await retryWrite(target, valueSample);
      readback = await readFromEditor(target);
      if (normalize(readback).includes(normalize(valueSample))) {
        return {
          filled: true,
          diagnostic: "",
          editorType: target.type,
          scopeSource: resolved.source,
        };
      }
    } catch {
      // retry 失败就当失败处理
    }
    diagnostic.push(
      `${describeScope(resolved)} 编辑器(${target.type})回读未包含目标文本；实际=${JSON.stringify(readback.slice(0, 80))}`,
    );
  }

  // 全部作用域都跑完仍未成功：拼一份「未找到作用域/编辑器」的诊断给上层。
  if (diagnostic.length === 0) {
    diagnostic.push(
      `既未找到 label 锚定的 .ant-form-item（匹配 ${LABEL_KEYWORDS.join(" / ")} 文本），` +
        `也未找到 ${FEATURES_FALLBACK_CONTAINERS.join(" / ")} fallback 容器；` +
        `请检查产品图文页 DOM 是否改版`,
    );
  }

  return { filled: false, diagnostic: diagnostic.join("；") };
}

export {
  LABEL_KEYWORD,
  LABEL_KEYWORDS,
  FEATURES_FALLBACK_CONTAINER,
  FEATURES_FALLBACK_CONTAINERS,
};
