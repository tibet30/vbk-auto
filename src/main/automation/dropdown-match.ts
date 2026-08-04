/**
 * 下拉候选匹配：从已收集的 dropdown 文本里找出最像 desired 的那一项。
 *
 * 算法（按顺序）：
 *   1. 「唯一可用项」直接选 — 下拉里只有一个非空、非 disabled 的真实项时
 *      直接选它，不管文本是否匹配。常见于「搜索 API 没匹配但返回了兜底项」、
 *      「只搜到一个相似名」之类场景。
 *   2. 「零可用项」返回 null — 下拉只展示了 Not Found / 加载中 / 空 等
 *      装饰文案，没有任何可选项；调用方应走原报错路径。
 *   3. 「多项 + aliases 命中」走 exact — aliases 列表里任意一项与候选文本
 *      完全相等即返回该候选，源标记为 "exact"。
 *   4. 「多项 + aliases 未命中」走 AI 兜底 — 把 desired + 全部 enabled 候选
 *      一并喂给 disambiguator，让 AI 选最像的。源标记为 "ai"，并返回 reasoning。
 *   5. 「AI 选中文本不在原 candidates 中」返回 null — 二次校验防止 AI 幻觉
 *      点中根本不存在的项。
 *
 * 保护制：
 *   - 文本含境外国家前缀（朝鲜 / 北朝鲜 / 韩国 / 日本 / 蒙古 / 俄罗斯-）
 *     的候选一律不喂给 AI，避免它误中「朝鲜-大同」这种境外同名项
 *     导致 VBK 弹「数据风险」弹窗。
 *   - disableds[i] === true 的候选跳过任何选中路径。
 *   - AI 抛错 try/catch，降级为 null，不拖崩上游。
 */

export interface MatchDropdownCandidate {
  /** 可选：在 AI 调用里作为 id 回传；不传则用 index。 */
  id?: string | number;
  /** 选项展示文本，必须与 DOM 内文本完全一致（已 trim）。 */
  text: string;
}

export interface MatchDropdownContext {
  kind: "province" | "city" | "spot" | "station";
  desired: string;
  product?: Record<string, unknown>;
  description?: string;
}

export interface MatchDropdownResult {
  /** candidates 数组里的索引。 */
  index: number;
  /** 选中的文本（与 candidates[index].text 一致）。 */
  text: string;
  /** 命中源。 */
  source: "single" | "exact" | "ai";
  /** AI 命中时返回模型的 reasoning；其它源为 undefined。 */
  reasoning?: string;
}

export type Disambiguator = (input: {
  kind: MatchDropdownContext["kind"];
  desired: string;
  candidates: Array<{ id?: string | number; text: string }>;
  product?: Record<string, unknown>;
}) => Promise<{ pickedText: string; reasoning?: string }>;

/**
 * 接送站/景点/省份/城市下拉统一匹配。
 *
 * @param candidates 选项列表（含 id / text）。text 为空 / 仅含空白视作无效。
 * @param disableds 与 candidates 等长的 disabled 标记数组（true 跳过）。
 * @param aliases 期望精确匹配的文本集合（city / 城市名 / 中国-城市 等）。
 * @param context 调用方上下文：kind + desired + product 用于 AI。
 * @param disambiguator AI 兜底回调；不传则只能精确命中 / 唯一项。
 * @returns 命中项（含 index / text / source）或 null（无可用 / 无精确 / AI 失败）。
 */
export async function matchDropdownOption(
  candidates: MatchDropdownCandidate[],
  disableds: boolean[],
  aliases: string[],
  context: MatchDropdownContext,
  disambiguator: Disambiguator | null | undefined,
): Promise<MatchDropdownResult | null> {
  // 0. 算出「可用 candidates」的下标。过滤规则：
  //   - disableds[i] === true → 跳过
  //   - text.trim() 为空 → 跳过
  //   - text 是下拉里的纯装饰文案（Not Found / 加载中 / Loading 等）→ 跳过
  //   这些「Not Found」项在 VBK 拽口中是接口返回空结果时送的占位文案，
  //   不应当作“唯一项”直接选中，也不应当交给 AI 选。
  const decorativeText = /^(?:not\s*found|loading|加载中|暂无数据|暂无结果|搜索中|请选择)$/i;
  const enabledIndexes: number[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (disableds[i]) continue;
    const text = (candidates[i].text || "").trim();
    if (!text) continue;
    if (decorativeText.test(text)) continue;
    enabledIndexes.push(i);
  }

  // 1. 唯一可用项 = 直接选。常见的「下拉里只剩 Not Found + 唯一真实项」场景
  // 下，Not Found 被过滤后只剩唯一真实项，调用方不用 AI 也能命中。
  if (enabledIndexes.length === 1) {
    const i = enabledIndexes[0];
    return { index: i, text: candidates[i].text, source: "single" };
  }

  // 2. 零可用项 = 下拉空了；返回 null 让上游决定如何报。
  if (!enabledIndexes.length) return null;

  // 3. 多个可用项 + aliases 命中 = exact。
  const aliasSet = new Set(aliases.filter((v) => typeof v === "string" && v.length > 0));
  for (const i of enabledIndexes) {
    if (aliasSet.has(candidates[i].text)) {
      return { index: i, text: candidates[i].text, source: "exact" };
    }
  }

  // 4. 多个可用项 + aliases 未命中 = AI 兜底。
  if (!disambiguator) return null;
  const foreignPrefix = /(?:^|[\s\u3000])(?:朝鲜|北朝鲜|韩国|日本|蒙古|俄罗斯)\s*[-—–]/;
  const enabledCandidates = enabledIndexes
    .map((i) => ({ id: candidates[i].id, text: candidates[i].text, disabled: false }))
    .filter((entry) => entry.text && !foreignPrefix.test(entry.text));
  if (!enabledCandidates.length) return null;
  try {
    const dis = await disambiguator({
      kind: context.kind,
      desired: context.desired,
      candidates: enabledCandidates.map((entry) => ({ id: entry.id, text: entry.text })),
      product: context.product,
    });
    if (!dis.pickedText) return null;
    // 二次校验：AI 选中的文本必须真实存在于原 candidates 且非 disabled。
    for (const i of enabledIndexes) {
      if (candidates[i].text === dis.pickedText) {
        return { index: i, text: dis.pickedText, source: "ai", reasoning: dis.reasoning };
      }
    }
    console.warn("[matchDropdownOption] AI 选中的文本不在 candidates 中", {
      kind: context.kind,
      desired: context.desired,
      pickedText: dis.pickedText,
    });
    return null;
  } catch (error) {
    console.warn("[matchDropdownOption] AI 失败，降级到原报错路径", {
      kind: context.kind,
      desired: context.desired,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}