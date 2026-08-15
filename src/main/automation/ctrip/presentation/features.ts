// @ts-nocheck
/**
 * 「产品特色」富文本编辑器定位与写入主入口：
 *   - findFeaturesFormItem / findFeaturesFallbackContainers / findEditorInScope 在
 *     ./features.find.ts；
 *   - writeToEditor / readFromEditor / retryWrite 在 ./features.write.ts；
 *   - syncReactStateForTarget 在 ./features.react-sync.ts；
 *   - 顶层 fillProductFeatures 在本文件，按 label 锚点 → fallback 容器 → 写入 → 回读 →
 *     React 同步的状态机走完；
 *   - React 同步只对 iframe-body 生效（textarea / input / contenteditable 走 fill 已经被
 *     Playwright 触发原生 input 事件），不影响旧版非 React 路径；
 *   - 失败抛「找不到产品特点富文本输入框」并附诊断，绝不静默保存。
 *
 * 顶部带 `// @ts-nocheck`，因为 page / locator 类型是动态传入。
 *
 * 历史（DOM 演进，按真实 Electron CDP 探测结果）：
 *   - VBK 老版文案：「产品特点」label + #pm_features 容器 + 普通 textarea；
 *   - VBK 新版（productImageText?productId=76906037）：「产品特色」label +
 *     #briefeditor 容器 + UEditor iframe #ueditor_0；
 *   - 同时支持两套 DOM，避免维护两套实现；label 关键词与 fallback 容器都按优先级链处理。
 */

import type { AnyScope, FeaturesResult } from "./features.types.js";
import {
  FEATURES_FALLBACK_CONTAINER,
  FEATURES_FALLBACK_CONTAINERS,
  LABEL_KEYWORD,
  LABEL_KEYWORDS,
  READBACK_DEADLINE_MS,
} from "./features.types.js";
import {
  describeScope,
  findEditorInScope,
  findFeaturesFallbackContainers,
  findFeaturesFormItem,
} from "./features.find.js";
import {
  readbackIncludes,
  readFromEditor,
  retryWrite,
  trySyncReactState,
  writeToEditor,
} from "./features.write.js";
import { delay } from "../utils.js";
import { formatProductFeaturesHtml } from "../../../domain/product/features-rich-text.js";

/**
 * 「产品特色」顶层入口：
 *   1) 先用可见「产品特色」/「产品特点」label 锚定 .ant-form-item 容器（优先级链遍历）；
 *   2) label 锚点失败或容器内无编辑器时，按优先级尝试 #briefeditor / #pm_features fallback；
 *   3) 在容器作用域内顺位挑 textarea / input / contenteditable / iframe body（iframe 校验
 *      body 可写），不允许全页 scan；
 *   4) 写入后回读校验文本已存在；
 *   5) iframe-body 命中后额外触发 React 状态同步（详见 features.react-sync.ts）；
 *   6) 失败抛「找不到产品特点富文本输入框」并附诊断（不静默保存）。
 */
export async function fillProductFeatures(page, value: string): Promise<FeaturesResult> {
  const valueSample = formatProductFeaturesHtml(value);
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
    let readback: any = "";
    let success = false;
    try {
      await writeToEditor(target, valueSample);
      const deadline = Date.now() + READBACK_DEADLINE_MS;
      readback = await readFromEditor(target);
      success = readbackIncludes(readback, valueSample);
      while (!success && Date.now() < deadline) {
        await delay(120);
        readback = await readFromEditor(target);
        success = readbackIncludes(readback, valueSample);
      }
    } catch (error) {
      diagnostic.push(`${describeScope(resolved)} 写入失败(${target.type})：${(error as Error).message}`);
      continue;
    }
    if (success) {
      // iframe-body 命中 UEditor 后，额外尝试同步 React 受控 state；
      // textarea / input / contenteditable 已被 fill 触发原生 input，React 一般自处理。
      let reactSynced: boolean | undefined;
      let reactField: string | undefined;
      let reactDiagnostic = "";
      let reactDetected = false;
      try {
        const outcome = await trySyncReactState(target, valueSample, page);
        reactSynced = outcome.synced ? true : undefined;
        reactField = outcome.field;
        reactDiagnostic = outcome.diagnostic;
        reactDetected = Boolean(outcome.reactDetected);
      } catch (error) {
        reactDiagnostic = `React 同步抛错：${(error as Error).message}`;
        // 抛出说明 React 同步 helper 自身有 bug，等同 React 同步失败 —— 阻断。
        reactDetected = true;
      }
      // 关键：「React 已检测但同步失败」必须阻断保存，让 fillProductFeatures
      // 返回 filled=false。否则 UEditor body 写成功 + React store 空值 → 保存
      // 请求会带空 description 提交，业务侧误报「保存成功」。
      if (reactDetected && !reactSynced) {
        return {
          filled: false,
          diagnostic: reactDiagnostic || "React 受控状态同步失败，已阻断保存",
          editorType: target.type,
          scopeSource: resolved.source,
          reactSynced: false,
          reactField,
        };
      }
      return {
        filled: true,
        diagnostic: reactDiagnostic,
        editorType: target.type,
        scopeSource: resolved.source,
        reactSynced,
        reactField,
      };
    }
    // 一次 retry：清空再写一次，覆盖 React 受控组件首次未触发 onChange 的情况
    try {
      await retryWrite(target, valueSample);
      readback = await readFromEditor(target);
      if (readbackIncludes(readback, valueSample)) {
        let reactSynced: boolean | undefined;
        let reactField: string | undefined;
        let reactDiagnostic = "";
        let reactDetected = false;
        try {
          const outcome = await trySyncReactState(target, valueSample, page);
          reactSynced = outcome.synced ? true : undefined;
          reactField = outcome.field;
          reactDiagnostic = outcome.diagnostic;
          reactDetected = Boolean(outcome.reactDetected);
        } catch (error) {
          reactDiagnostic = `React 同步抛错：${(error as Error).message}`;
          reactDetected = true;
        }
        if (reactDetected && !reactSynced) {
          return {
            filled: false,
            diagnostic: reactDiagnostic || "React 受控状态同步失败，已阻断保存",
            editorType: target.type,
            scopeSource: resolved.source,
            reactSynced: false,
            reactField,
          };
        }
        return {
          filled: true,
          diagnostic: reactDiagnostic,
          editorType: target.type,
          scopeSource: resolved.source,
          reactSynced,
          reactField,
        };
      }
    } catch {
      // retry 失败就当失败处理
    }
    diagnostic.push(
      `${describeScope(resolved)} 编辑器(${target.type})回读未包含目标文本；实际=${JSON.stringify(typeof readback === "string" ? readback.slice(0, 80) : readback)}`,
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

// 向后兼容旧单值导出（与原 features.ts 完全等价）
export {
  LABEL_KEYWORD,
  LABEL_KEYWORDS,
  FEATURES_FALLBACK_CONTAINER,
  FEATURES_FALLBACK_CONTAINERS,
};
// 重新导出内部工具便于测试切片复用
export {
  describeScope,
  findEditorInScope,
  findFeaturesFallbackContainers,
  findFeaturesFormItem,
} from "./features.find.js";
export {
  normalize,
  readbackIncludes,
  readFromEditor,
  retryWrite,
  writeToEditor,
} from "./features.write.js";
export {
  syncReactOnChange,
  syncReactStateForTarget,
  type ReactSyncOutcome,
} from "./features.react-sync.js";
export type {
  AnyScope,
  EditorTarget,
  FallbackScope,
  FeaturesResult,
  LabelScope,
} from "./features.types.js";
