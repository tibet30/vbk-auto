/**
 * React 状态窄同步 helper 的对外形状 + 同步轮询常量。
 *
 * 同步命中判定同步轮询间隔（ms）。
 */
export const REACT_SYNC_POLL_MS = 80;
/** fiber 树向上遍历的最大层数（典型组件深度远小于 25）。 */
export const MAX_FIBER_DEPTH = 25;

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