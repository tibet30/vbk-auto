// @ts-nocheck
/**
 * 「产品特色」作用域 + 编辑器定位 helper：
 *   - findFeaturesFormItem：用可见「产品特色」/「产品特点」label 反查最近的 .ant-form-item 容器；
 *   - findFeaturesFallbackContainers：依次尝试 #briefeditor / #pm_features 可见 fallback 容器
 *     （新旧两套 DOM 都覆盖，priority chain）；
 *   - findEditorInScope：在容器作用域内按 textarea > input > [contenteditable] > iframe body
 *     顺位挑选；iframe 候选会校验 body 可写（contenteditable / isContentEditable），
 *     避免命中隐藏的 _ueditor 同步框等不可写 iframe；
 *   - describeScope：把 LabelScope / FallbackScope 压平成诊断用字符串。
 *
 * 顶部带 `// @ts-nocheck`，因为 page / locator 类型是动态传入。
 *
 * 历史（DOM 演进，按真实 Electron CDP 探测结果）：
 *   - VBK 老版文案：「产品特点」label + #pm_features 容器 + 普通 textarea；
 *   - VBK 新版（productImageText?productId=76906037）：「产品特色」label +
 *     #briefeditor 容器 + UEditor iframe #ueditor_0；
 *   - 同时支持两套 DOM，避免维护两套实现；label 关键词与 fallback 容器都按优先级链处理。
 */

import type { AnyScope, EditorTarget, FallbackScope, LabelScope } from "./features.types.js";
import { FEATURES_FALLBACK_CONTAINERS, LABEL_KEYWORDS } from "./features.types.js";

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

export {
  describeScope,
  findEditorInScope,
  findFeaturesFallbackContainers,
  findFeaturesFormItem,
};