/**
 * POI 核查任务的稳定语义。
 *
 * 历史版本曾为同一景点写入两种标签。这里集中识别并规范化它们，保证生成、
 * 落库去重和详情呈现都把它们视为同一个 VBK 核查问题。
 */

export const POI_RESEARCH_TASK_TYPE = "vbk" as const;

const legacyNoMatch = /^待核查景点\s+(.+?)\s+的\s+VBK\s+POI$/;
const legacyCityPoi = /^核查\s+(.+?)\s+在\s+VBK\s+资源库的\s+city\s*\/\s*poi\s*映射$/i;
const canonicalPoi = /^核查\s+(.+?)\s+的\s+VBK\s+POI\s+映射$/;

export function poiResearchTaskLabel(name: string): string {
  return `核查 ${name.trim()} 的 VBK POI 映射`;
}

/** Returns the POI name when this is one of the legacy or canonical POI tasks. */
export function poiResearchTaskName(label: string, type: string): string | undefined {
  if (type !== POI_RESEARCH_TASK_TYPE) return undefined;
  const match = label.trim().match(canonicalPoi) ?? label.trim().match(legacyNoMatch) ?? label.trim().match(legacyCityPoi);
  const name = match?.[1]?.trim();
  return name || undefined;
}

/**
 * 解析一条 POI 核查任务实际覆盖的景点名称。
 *
 * 早期行程会把用户明确的“二选一”写成一个 spot，并随之产生
 * “核查 A 或 B 的 VBK POI 映射”任务。它不是一个叫“A 或 B”的景点；
 * 每个备选景点都配置完成后，任务才可以自动结案。
 */
export function poiResearchTaskNames(label: string, type: string): string[] {
  const name = poiResearchTaskName(label, type);
  if (!name) return [];
  return [...new Set(name.split(/\s*(?:或者|或)\s*/).map((item) => item.trim()).filter(Boolean))];
}

/** Converts known POI task spellings to their single canonical label. */
export function canonicalPoiResearchTaskLabel(label: string, type: string): string {
  const names = poiResearchTaskNames(label, type);
  return names.length > 0 ? poiResearchTaskLabel(names.join(" 或 ")) : label;
}

export function isSamePoiResearchTask(
  left: Pick<{ label: string; type: string }, "label" | "type">,
  right: Pick<{ label: string; type: string }, "label" | "type">,
): boolean {
  const leftNames = poiResearchTaskNames(left.label, left.type);
  const rightNames = poiResearchTaskNames(right.label, right.type);
  return leftNames.length > 0 && leftNames.join("\u0000") === rightNames.join("\u0000");
}
