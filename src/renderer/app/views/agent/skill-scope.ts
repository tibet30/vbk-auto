/**
 * 任务级 Skill 启停的界面语义。
 *
 * `enabledSkills` 未设置（undefined）表示"全部启用"；数组表示只启用这些（空数组 = 全停）。
 * 打开最后一个被停用的 Skill 时回到 undefined，避免把"全部启用"固化成一份显式清单
 * ——否则以后新增 Skill 时老任务会莫名其妙用不上。
 */

export function isSkillEnabled(current: readonly string[] | undefined, skillId: string): boolean {
  return current === undefined || current.includes(skillId);
}

export function nextEnabledSkills(
  allSkillIds: readonly string[],
  current: readonly string[] | undefined,
  toggled: string,
): string[] | null {
  const enabled = current === undefined ? [...allSkillIds] : [...current];
  const known = enabled.filter((id) => allSkillIds.includes(id));
  const next = known.includes(toggled)
    ? known.filter((id) => id !== toggled)
    : [...known, toggled];
  const coversAll = allSkillIds.length > 0 && allSkillIds.every((id) => next.includes(id));
  return coversAll ? null : next;
}

/** 停用了哪些 Skill（供界面提示"本任务只启用了部分能力"）。 */
export function disabledSkillIds(allSkillIds: readonly string[], current: readonly string[] | undefined): string[] {
  if (current === undefined) return [];
  return allSkillIds.filter((id) => !current.includes(id));
}
