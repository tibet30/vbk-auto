// @ts-nocheck
/**
 * 「产品特色」/「产品特点」helper 的常量与类型契约：
 *   - LABEL_KEYWORDS / FEATURES_FALLBACK_CONTAINERS：按优先级链组织；
 *   - FeaturesEditorType / FeaturesScopeSource / FeaturesResult：写入结果契约；
 *   - EditorTarget / AnyScope：内部定位辅助类型。
 *
 * 与 features.write.ts / features.find.ts / features.ts 配合使用，本文件只暴露纯数据与类型，
 * 不持有任何运行时副作用，便于测试切片识别与独立单测。
 */

/** 「产品特色」/「产品特点」label 关键词优先级：VBK 新版在前，老版兜底。 */
const LABEL_KEYWORDS = ["产品特色", "产品特点"] as const;
/** 有限度 fallback 容器优先级：#briefeditor（VBK 新版）先，#pm_features（老版）兜底。 */
const FEATURES_FALLBACK_CONTAINERS = ["#briefeditor", "#pm_features"] as const;
/** 写入后回读等待时间（ms），给 React / ueditor 触发 onChange 留缓冲。 */
const READBACK_DEADLINE_MS = 2_500;
/** React 状态同步附加等待时间（ms），覆盖 React 异步 dispatch 节奏。 */
const REACT_SYNC_DEADLINE_MS = 1_500;

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
  /** React 受控状态是否同步命中；undefined 表示页面无 React / 未尝试。 */
  reactSynced?: boolean;
  /** 命中的 React state 字段名（如 editproductDesc），未命中时 undefined。 */
  reactField?: string;
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

export {
  LABEL_KEYWORDS,
  LABEL_KEYWORD,
  FEATURES_FALLBACK_CONTAINERS,
  FEATURES_FALLBACK_CONTAINER,
  READBACK_DEADLINE_MS,
  REACT_SYNC_DEADLINE_MS,
};

export type { AnyScope, EditorTarget, FallbackScope, LabelScope };