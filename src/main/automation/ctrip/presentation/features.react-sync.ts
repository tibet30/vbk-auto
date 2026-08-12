// @ts-nocheck
/**
 * 「产品特色」React 状态窄同步 helper（with **direct onChange(html) + ancestor state 校验**）：
 *
 * 真实证据（Electron CDP 在 productImageText?productId=76906037 上观察到）：
 *   - UEditor setContent + sync 后，body 与 hidden textarea 都有目标文本；
 *   - 但携程 React store 的 editproductDesc 仍为空，原因是 UEditor 不通过 React 的 onChange
 *     链路写入受控 state；
 *   - 因此保存时会带空值提交，业务侧被「保存成功」误导但实际未落库；
 *   - 必须显式调用 React 组件 props.onChange(html)，把目标 HTML 灌进 React store。
 *
 * 设计约束（按用户窄修复要求）：
 *   - 在 page 主文档的 #briefeditor 容器上动态查找 React fiber；
 *   - 沿 fiber.return 链向上找到含 memoizedProps.onChange 的编辑器组件；
 *   - **直接调用 onChange(html)**（不构造合成事件，符合用户契约 onChange(html)）；
 *   - 调用后沿 fiber.return 链向上找祖先组件的 `props.state.editproductDesc`
 *     （或 stateNode.state.editproductDesc，兼容 class 组件）；
 *   - 验证祖先 state.editproductDesc 包含目标文本才算同步成功；
 *   - 无 React / 找不到 onChange → 返回 synced=false + 空 diagnostic（向后兼容，
 *     既不污染主写入路径、也不让 FeaturesResult.diagnostic 出现「成功路径却有错误」）；
 *   - 不构造残缺 payload、不读取页面无关敏感字段，绝不接触 cookie。
 *
 * 纯 helper（normalize / readFiberKeys / pickFiberKey / isFiberObject / pickFirstFiberAnchor）
 * 在 ./features.react-helpers.ts；本文件聚焦 page.evaluate 编排。
 */

import type { EditorTarget } from "./features.types.js";
import { REACT_SYNC_DEADLINE_MS } from "./features.types.js";
import {
  isFiberObject,
  normalize,
  pickFiberKey,
  pickFirstFiberAnchor,
  readFiberKeys,
} from "./features.react-helpers.js";

/** 同步命中判定同步轮询间隔（ms）。 */
const REACT_SYNC_POLL_MS = 80;
/** fiber 树向上遍历的最大层数（典型组件深度远小于 25）。 */
const MAX_FIBER_DEPTH = 25;

export interface ReactSyncOutcome {
  /** 是否成功调用了 React onChange 并在祖先 state 中验证命中。 */
  synced: boolean;
  /** 同步命中的 React state 字段名（典型值：editproductDesc）。 */
  field?: string;
  /**
   * 同步过程产生的诊断信息。
   *   - 成功路径：""；
   *   - 无 React / 不需要同步：""（向后兼容，不污染 FeaturesResult.diagnostic）；
   *   - 真实失败（onchange-threw / 祖先 state 不含目标文本 / 过程异常）：可操作的错误描述。
   */
  diagnostic: string;
  /**
   * 本次同步是否真的「检测到了 React」并尝试过 onChange 调用。
   *   - false：DOM 上根本找不到 React fiber / 找不到 #briefeditor / 不需要同步
   *     （iframe-body 以外的 type）—— 旧版非 React 页面场景，调用方按
   *     「向后兼容」处理，不阻断保存。
   *   - true：DOM 上确实有 React fiber 且 onChange 已被调用过，但最终 ancestor
   *     state.editproductDesc 校验失败 —— 调用方必须把这个结果视作硬阻塞
   *     （filled=false 或直接抛错），阻止后续保存落到空值。
   *
   * 与 `synced` 并不互斥：true 场景下 synced 通常为 false，但调用方需要明确
   * 区分「页面没 React 所以向后兼容」与「页面有 React 但同步失败必须阻断」两条
   * 路径，避免把 React 同步失败误判为「没有 React 所以放行」。
   */
  reactDetected: boolean;
}

/* ============================================================
 * 同步主流程
 * ============================================================ */

/**
 * 把目标 HTML 同步到 React 受控状态：
 *   1) 在主文档上找 #briefeditor 容器节点；
 *   2) 在容器子树内任选一个真实存在的 DOM 节点（root 或首个带 __reactFiber$ 的后代）；
 *   3) 向上遍历 fiber.return 链，找首个含 memoizedProps.onChange 的组件；
 *   4) **直接调用 onChange(html)**（不构造合成事件，符合用户契约）；
 *   5) 同步后再次沿 fiber.return 链向上找祖先组件的
 *      - memoizedProps.state.editproductDesc
 *      - pendingProps.state.editproductDesc
 *      - stateNode.state.editproductDesc
 *      三种位置，验证祖先 state.editproductDesc 包含目标文本；
 *   6) 命中即返回 synced=true，否则 synced=false + 明确诊断。
 *
 * 无 React / 找不到 onChange / 祖先 state 不命中 → synced=false，绝不抛错。
 * - 无 React 情况：diagnostic = ""（向后兼容，避免 FeaturesResult 出现误导性诊断）；
 * - 真实失败情况：diagnostic = 可操作错误描述。
 */
async function syncReactOnChange(html: string, page: any): Promise<ReactSyncOutcome> {
  try {
    /**
     * 第一阶段：找 editor 组件并调用 onChange(html)。
     * 返回 union：
     *   { kind: "ok" }                                  → 已调用；
     *   { kind: "no-briefeditor" | "no-fiber" | "no-onchange" } → 无 React；
     *   { kind: "onchange-threw", message }            → onChange 抛错。
     */
    const setupResult = await page.evaluate((targetHtml: string) => {
      const root = document.querySelector("#briefeditor");
      if (!root) return { kind: "no-briefeditor" };
      // 选一个真正挂在 fiber 上的 DOM 节点：root 自身如果没有 fiber，就向下找首个有 fiber 的节点。
      // 必须用 Object.getOwnPropertyNames：React production 构建通过 Object.defineProperty
      // 挂载 fiber key（enumerable=false），Object.keys 会漏；这里同时兼容
      // __reactFiber$<random>（React 17+ production）与 __reactInternalInstance$<random>（React 16 旧版）。
      //
      // 关键：本回调里**完全自包含** —— 不声明任何局部函数（无论箭头 / function 声明），
      // 只用最朴素的 for + if + Object.getOwnPropertyNames 内联扫描。tsx/esbuild 的
      // keep_names 会给局部箭头函数包裹 `__name(fn, "key")`，而 `__name` 在浏览器
      // 上下文不存在，会抛 ReferenceError；不声明局部函数就不会触发 __name 注入。
      let anchor: Element | null = root;
      let anchorKeys: string[] = [];
      const rootNames = Object.getOwnPropertyNames(root);
      for (let n = 0; n < rootNames.length; n += 1) {
        const name = rootNames[n]!;
        if (name.indexOf("__reactFiber$") === 0 || name.indexOf("__reactInternalInstance$") === 0) {
          anchorKeys.push(name);
        }
      }
      if (anchorKeys.length === 0) {
        const walker = (root as unknown as ParentNode).querySelectorAll("*");
        outer: for (let i = 0; i < walker.length; i += 1) {
          const candidate = walker[i] as unknown as object;
          const candidateNames = Object.getOwnPropertyNames(candidate);
          const found: string[] = [];
          for (let n = 0; n < candidateNames.length; n += 1) {
            const name = candidateNames[n]!;
            if (name.indexOf("__reactFiber$") === 0 || name.indexOf("__reactInternalInstance$") === 0) {
              found.push(name);
            }
          }
          if (found.length > 0) {
            anchor = walker[i] as Element;
            anchorKeys = found;
            break outer;
          }
        }
      }
      if (!anchor) return { kind: "no-fiber" };
      const finalKeys: string[] = [];
      const finalNames = Object.getOwnPropertyNames(anchor as unknown as object);
      for (let n = 0; n < finalNames.length; n += 1) {
        const name = finalNames[n]!;
        if (name.indexOf("__reactFiber$") === 0 || name.indexOf("__reactInternalInstance$") === 0) {
          finalKeys.push(name);
        }
      }
      if (finalKeys.length === 0) return { kind: "no-fiber" };
      const startFiber = (anchor as unknown as Record<string, any>)[finalKeys[0]!];

      const visited = new WeakSet<object>();
      let node: any = startFiber;
      for (let depth = 0; node && depth < 25; depth += 1) {
        if (typeof node !== "object" || node === null || visited.has(node)) break;
        visited.add(node);
        const memoizedProps = node.memoizedProps;
        const pendingProps = node.pendingProps;
        let onChange: any = null;
        for (let propsIndex = 0; propsIndex < 2; propsIndex += 1) {
          const props = propsIndex === 0 ? memoizedProps : pendingProps;
          if (!props || typeof props !== "object") continue;
          const candidate = (props as any).onChange;
          if (typeof candidate === "function") {
            onChange = candidate;
            break;
          }
        }
        if (onChange) {
          try {
            // **直接调用 onChange(html)**，符合用户契约 memoizedProps.onChange(html)。
            onChange(targetHtml);
          } catch (err) {
            return {
              kind: "onchange-threw",
              message: ((err as Error)?.message ?? String(err)),
            };
          }
          return { kind: "ok" };
        }
        node = node.return ?? null;
      }
      return { kind: "no-onchange" };
    }, html);

    if (!setupResult || (setupResult as any).kind !== "ok") {
      const kind = (setupResult as any)?.kind;
      // 无 React / 找不到 onChange → 向后兼容：返回 synced=false + 空 diagnostic。
      // 注意：这种情况 reactDetected=false —— DOM 上根本没看到 React fiber，
      // 走的是「无 React 旧页兼容」路径，调用方不应阻断保存。
      if (
        kind === "no-briefeditor" ||
        kind === "no-fiber" ||
        kind === "no-onchange"
      ) {
        return { synced: false, diagnostic: "", reactDetected: false };
      }
      // 真实失败（onChange 抛错）：说明我们已经找到了 React fiber 并调用了 onChange
      // —— reactDetected=true，调用方必须把这个结果视作硬阻塞，阻止保存。
      return {
        synced: false,
        diagnostic: `React 同步失败（${kind ?? "unknown"}）：${(setupResult as any)?.message ?? ""}`,
        reactDetected: true,
      };
    }

    /**
     * 第二阶段：等 React 异步 dispatch 落库，再回读一次 fiber 树上的祖先
     * `state.editproductDesc` 确认同步命中。
     */
    const deadline = Date.now() + REACT_SYNC_DEADLINE_MS;
    let lastSource = "";
    let lastText = "";
    while (Date.now() < deadline) {
      const readback = await page.evaluate(() => {
        const root = document.querySelector("#briefeditor");
        if (!root) return { ok: false };
        // 同 setupResult：必须用 Object.getOwnPropertyNames 兼容非可枚举 fiber key；
        // 本回调同样**不声明任何局部函数**，仅内联前缀扫描 —— 避免 tsx/esbuild
        // 的 keep_names 注入 `__name(fn, "key")`，`__name` 在浏览器上下文不存在会
        // 抛 ReferenceError。复制 setupResult 的实现而不是抽成函数是为了保持每个
        // evaluate 回调自包含、零外部依赖。
        let anchor: Element | null = root;
        let anchorKeys: string[] = [];
        const rootNames = Object.getOwnPropertyNames(root);
        for (let n = 0; n < rootNames.length; n += 1) {
          const name = rootNames[n]!;
          if (name.indexOf("__reactFiber$") === 0 || name.indexOf("__reactInternalInstance$") === 0) {
            anchorKeys.push(name);
          }
        }
        if (anchorKeys.length === 0) {
          const walker = root.querySelectorAll("*");
          outer: for (let i = 0; i < walker.length; i += 1) {
            const candidate = walker[i] as unknown as object;
            const candidateNames = Object.getOwnPropertyNames(candidate);
            const found: string[] = [];
            for (let n = 0; n < candidateNames.length; n += 1) {
              const name = candidateNames[n]!;
              if (name.indexOf("__reactFiber$") === 0 || name.indexOf("__reactInternalInstance$") === 0) {
                found.push(name);
              }
            }
            if (found.length > 0) {
              anchor = walker[i] as Element;
              anchorKeys = found;
              break outer;
            }
          }
        }
        if (!anchor) return { ok: false };
        const finalKeys: string[] = [];
        const finalNames = Object.getOwnPropertyNames(anchor as unknown as object);
        for (let n = 0; n < finalNames.length; n += 1) {
          const name = finalNames[n]!;
          if (name.indexOf("__reactFiber$") === 0 || name.indexOf("__reactInternalInstance$") === 0) {
            finalKeys.push(name);
          }
        }
        if (finalKeys.length === 0) return { ok: false };
        const startFiber = (anchor as unknown as Record<string, any>)[finalKeys[0]!];

        const visited = new WeakSet<object>();
        let node: any = startFiber;
        for (let depth = 0; node && depth < 25; depth += 1) {
          if (typeof node !== "object" || node === null || visited.has(node)) break;
          visited.add(node);

          const memoizedProps = node.memoizedProps;
          const pendingProps = node.pendingProps;
          for (let propsIndex = 0; propsIndex < 2; propsIndex += 1) {
            const props = propsIndex === 0 ? memoizedProps : pendingProps;
            if (!props || typeof props !== "object") continue;
            const state = (props as any).state;
            if (state && typeof state === "object") {
              const desc = (state as any).editproductDesc;
              if (typeof desc === "string") {
                return { ok: true, text: desc, source: "props.state" };
              }
            }
          }
          const stateNode = node.stateNode;
          if (stateNode && typeof stateNode === "object") {
            const state = (stateNode as any).state;
            if (
              state &&
              typeof state === "object" &&
              typeof (state as any).editproductDesc === "string"
            ) {
              return { ok: true, text: (state as any).editproductDesc, source: "stateNode.state" };
            }
          }
          node = node.return ?? null;
        }
        return { ok: false };
      });

      if (readback && (readback as any).ok) {
        lastSource = (readback as any).source ?? "";
        lastText = (readback as any).text ?? "";
        if (normalize(lastText).includes(normalize(html))) {
          return {
            synced: true,
            field: "editproductDesc",
            diagnostic: "",
            reactDetected: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, REACT_SYNC_POLL_MS));
    }

    return {
      synced: false,
      field: "editproductDesc",
      diagnostic:
        `React onChange 已调用，但祖先 ${lastSource || "props/state.state"}` +
        `.editproductDesc 在 ${REACT_SYNC_DEADLINE_MS}ms 内未含目标文本；` +
        `最后回读=${JSON.stringify(lastText.slice(0, 80))}`,
      // setupResult.kind === "ok" 才走到这一分支，说明 React fiber + onChange 都已
      // 检测到，必须把 reactDetected=true 让调用方阻断保存。
      reactDetected: true,
    };
  } catch (error) {
    // 异常分支：可能发生在 setupResult 已确认 React 存在之后（如 readback 异常），
    // 也可能发生在更早的入参解析 / evaluate 阶段。最安全的策略是把 reactDetected
    // 设为 true（保守阻断）；调用方若要区分，仍可通过 diagnostic 文本判断。
    return {
      synced: false,
      diagnostic: `React 同步过程异常：${(error as Error).message}`,
      reactDetected: true,
    };
  }
}

/**
 * EditorTarget 上做 React 状态同步的入口：
 *   - 只对 iframe-body 生效（UEditor / wangEditor 这类隐藏 hidden 的富文本），
 *     textarea / input / contenteditable 直接 fill 已经触发原生 input 事件，React 一般
 *     会自己 onChange，不需要额外补救；
 *   - 其它类型直接返回 synced=false + 空 diagnostic（向后兼容，不让 FeaturesResult
 *     在「不需要同步」的场景出现误导性诊断）；
 *   - 永远不抛错；调用方根据 synced 决定是否把结果写到 FeaturesResult.reactSynced。
 */
async function syncReactStateForTarget(
  target: EditorTarget,
  html: string,
  page: any,
): Promise<ReactSyncOutcome> {
  // 非 iframe-body 的 textarea / input / contenteditable 已被 Playwright fill 触发
  // 原生 input 事件，React 一般自处理 onChange，不需要 React 状态补救。
  // 这种情况 reactDetected=false —— 我们没尝试 React 同步，调用方按向后兼容
  // 处理（不阻断保存）。
  if (target.type !== "iframe-body") {
    return { synced: false, diagnostic: "", reactDetected: false };
  }
  return syncReactOnChange(html, page);
}

/**
 * 列出某个 DOM 元素上的 React 内部 fiber / props 键名（保留对外 API）。
 * React 19 在 production 构建中随机化后缀（__reactFiber$xxxx / __reactProps$xxxx），
 * 因此用前缀扫描而不是直接取固定字段。
 */
function listReactKeys(element: any): string[] {
  return readFiberKeys(element);
}

/**
 * 从某 DOM 节点出发，向上遍历 React fiber 树寻找一个携带目标字段 onChange 的组件；
 * 一旦命中即返回该 fiber 与字段名；找不到返回 null。
 *
 * 限制：
 *   - 最多向上 25 层（典型组件深度不会超过这个数）；
 *   - 不读取 fiber 的内部状态，只读 pendingProps / memoizedProps.onChange + value；
 *   - 返回的字段名是真实 props key（驼峰 / 下划线都保留）。
 */
function findReactOnChangeInFiber(
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

export {
  findReactOnChangeInFiber,
  listReactKeys,
  syncReactOnChange,
  syncReactStateForTarget,
};

// 重导出纯 helper（便于测试切片识别与外部直接使用）
export {
  isFiberObject,
  normalize,
  pickFiberKey,
  pickFirstFiberAnchor,
  readFiberKeys,
} from "./features.react-helpers.js";