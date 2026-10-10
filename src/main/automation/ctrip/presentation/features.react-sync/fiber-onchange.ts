/**
 * 「产品特色」React 状态窄同步 helper（外部 API）：
 *   - listReactKeys：列出某 DOM 节点上的 React fiber / props 键名（保留旧 API）；
 *   - findReactOnChangeInFiber：从某 DOM 节点出发，向上遍历 React fiber 树
 *     寻找一个携带目标字段 onChange 的组件；找不到返回 null。
 *
 * 限制：
 *   - 最多向上 MAX_FIBER_DEPTH 层（典型组件深度不会超过这个数）；
 *   - 不读取 fiber 的内部状态，只读 pendingProps / memoizedProps.onChange + value；
 *   - 返回的字段名是真实 props key（驼峰 / 下划线都保留）。
 */

import { isFiberObject, readFiberKeys } from "../features.react-helpers.js";
import { MAX_FIBER_DEPTH } from "./types.js";

/**
 * 列出某个 DOM 元素上的 React 内部 fiber / props 键名（保留对外 API）。
 * React 19 在 production 构建中随机化后缀（__reactFiber$xxxx / __reactProps$xxxx），
 * 因此用前缀扫描而不是直接取固定字段。
 */
export function listReactKeys(element: any): string[] {
  return readFiberKeys(element);
}

/**
 * 从某 DOM 节点出发，向上遍历 React fiber 树寻找一个携带目标字段 onChange 的组件；
 * 一旦命中即返回该 fiber 与字段名；找不到返回 null。
 */
export function findReactOnChangeInFiber(
  start: any,
  candidates: ReadonlyArray<string>,
): { fiber: any; field: string } | null {
  if (!start) return null;
  const visited = new WeakSet<object>();
  let node: any = start;
  for (let depth = 0; node && depth < MAX_FIBER_DEPTH; depth += 1) {
    if (!isFiberObject(node, visited)) break;
    const memoizedProps = (node as any).memoizedProps;
    const pendingProps = (node as any).pendingProps;
    for (const props of [memoizedProps, pendingProps]) {
      if (!props || typeof props !== "object") continue;
      const onChange = (props as any).onChange;
      if (typeof onChange !== "function") continue;
      for (const candidate of candidates) {
        if (Object.prototype.hasOwnProperty.call(props, candidate)) {
          return { fiber: node, field: candidate };
        }
      }
    }
    node = (node as any).return ?? null;
  }
  return null;
}