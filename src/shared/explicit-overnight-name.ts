/**
 * 原文里明确写出的当晚住宿地：`（宿X）`、`住X` / `入住X` / `住宿：X`，以及运营最常用的
 * 行内简写 `宿X` / `宿：X` / `夜宿X` / `晚宿X` / `宿在X`。简写必须出现在分隔符
 * （空白、标点、`|`）之后，避免把「住宿」里的「宿」、地名宿州 / 宿迁 / 宿松当成住宿动作。
 */
const INLINE_OVERNIGHT = /(?:^|[\s，,。；;|｜])(?:当晚|当夜|夜|晚)?宿(?!州|迁|松)\s*(?:为|在|于|到|：|:)?\s*([^—–\-，,、。；;\n（()→|｜\s]{2,30})/u;
const STAY_VERB_OVERNIGHT = /(?:住宿|入住|住(?!宿))\s*(?:为|在|于|到|：|:)?\s*([^—–\-，,、。；;\n（(|｜→\s]{2,30})/u;

export function explicitOvernightName(source: string | undefined): string | undefined {
  if (!source) return undefined;
  return source.match(/[（(]\s*宿\s*([^）)]+)[）)]/u)?.[1]?.trim()
    || source.match(STAY_VERB_OVERNIGHT)?.[1]?.trim()
    || source.match(INLINE_OVERNIGHT)?.[1]?.trim()
    || undefined;
}
