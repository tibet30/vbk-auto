// @ts-nocheck
/**
 * 「产品特色」React 同步相关的纯 helper（无副作用、不依赖 page 调用）：
 *   - normalize：归一化字符串（去空白 / 全角空格）；
 *   - readFiberKeys：列出某 DOM 元素上的 React fiber / props 内部键名；
 *   - pickFiberKey：仅保留 __reactFiber$ 前缀的键；
 *   - isFiberObject：安全判断某 fiber 节点是否可遍历（弱引用防循环）；
 *   - pickFirstFiberAnchor：从 #briefeditor 子树挑首个携带 React fiber 的 DOM 节点。
 *
 * 这些 helper 不读取任何 cookie / Authorization / X-* 等凭据字段，不构造残缺 payload。
 * 顶部带 `// @ts-nocheck`，因为 element 类型是动态传入。
 */

/** 归一化字符串（去空白 / 全角空格），用于回读校验。 */
function normalize(value: string): string {
  return String(value || "").replace(/\s+/g, "").replace(/　/g, "");
}

/** 列出某 DOM 元素上的 React fiber / props 内部键名。
 *  用 Object.getOwnPropertyNames 兼容非可枚举属性（React production 构建
 *  通过 Object.defineProperty 挂载），并同时支持：
 *    - __reactFiber$<random>：React 17+ production
 *    - __reactInternalInstance$<random>：React 16 旧版
 *    - __reactProps$<random>：React 17+ 组件 props 引用
 */
function readFiberKeys(element: any): string[] {
  if (!element || typeof element !== "object") return [];
  const keys: string[] = [];
  for (const key of Object.getOwnPropertyNames(element)) {
    if (
      key.startsWith("__reactFiber$")
      || key.startsWith("__reactInternalInstance$")
      || key.startsWith("__reactProps$")
    ) {
      keys.push(key);
    }
  }
  return keys;
}

/** 保留 fiber 起点键名（onChange 调用时用 fiber 引用），
 *  同时覆盖 __reactFiber$ 与 React 16 旧版 __reactInternalInstance$。 */
function pickFiberKey(keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) return key;
  }
  return null;
}

/** 安全判断某 fiber 节点是否可遍历（弱引用防循环）。 */
function isFiberObject(node: unknown, visited: WeakSet<object>): node is Record<string, any> {
  if (typeof node !== "object" || node === null) return false;
  if (visited.has(node as object)) return false;
  visited.add(node as object);
  return true;
}

/** 从 #briefeditor（或其子树）挑出第一个真正携带 React fiber 的 DOM 节点；无则返回 null。 */
function pickFirstFiberAnchor(root: Element | null): Element | null {
  if (!root) return null;
  if (readFiberKeys(root).length > 0) return root;
  const all = root.querySelectorAll("*");
  for (let i = 0; i < all.length; i += 1) {
    if (readFiberKeys(all[i]).length > 0) return all[i];
  }
  return null;
}

export {
  isFiberObject,
  normalize,
  pickFiberKey,
  pickFirstFiberAnchor,
  readFiberKeys,
};