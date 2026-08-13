/**
 * 静态源码断言：保证 saveCtripLibraryCover 行为契约并避免手测回归。
 * 通过配对大括号 / 小括号 / 分号计数，从源码里精确切割出
 * `saveCtripLibraryCover = async (...) => { ... }` 整个函数体，不再依赖
 * `);` 截断（脆弱 regex 曾在第一个内层 `);` 处断尾，导致后续
 * `assert.match(body, /select.../ )` 全部错过）。
 */
import { test } from "../basic-info-fixes/basic-info-fixes.shared.js";
import { assert } from "../basic-info-fixes/basic-info-fixes.shared.js";
import { readFileSync } from "node:fs";
import path from "node:path";

const here = new URL(".", import.meta.url).pathname;
const productRoot = path.resolve(here, "..", "..");
const actionsPath = path.join(productRoot, "src/renderer/app/actions/basic-info.ts");
const actionsSource = readFileSync(actionsPath, "utf8");
const coverModelSource = readFileSync(path.join(productRoot, "src/renderer/app/actions/basic-info-cover-model.ts"), "utf8");

/**
 * 找到 `name = async (...) => {` 起点后，向右扫描直到配对 `}` 出现，截出
 * 完整函数体。同时显式支持 `(...args): ReturnType => {` 与 `async function`
 * 两种形态。当前文件里形如
 *   const saveCtripLibraryCover = async (localProductId, args) => { ... };
 * 用本工具都能切全。
 */
function extractFunctionBody(source: string, name: string): string {
  const patterns = [
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*async\\s*\\(`),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\(`),
    new RegExp(`function\\s+${name}\\s*\\(`),
  ];
  let head: RegExpExecArray | null = null;
  let openIdx = -1;
  for (const pattern of patterns) {
    head = pattern.exec(source);
    if (head) break;
  }
  if (!head) return "";
  const paramsStart = source.indexOf("(", head.index);
  let i = paramsStart;
  let parenDepth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) { i++; break; }
    }
    // 跳过字符串字面量内的括号误伤。
    if (ch === "'" || ch === "\"" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") { j += 2; continue; }
        if (c === quote) { j++; break; }
        if (c === "\n" && quote !== "`") break;
        j++;
      }
      i = j - 1;
    }
  }
  openIdx = i;
  // openIdx 是 `(...)<可选返回值类型> => {` 中 `{` 之前的位置；接下来找到 `{`。
  const braceStart = source.indexOf("{", openIdx);
  if (braceStart === -1) return "";
  let depth = 0;
  let j = braceStart;
  while (j < source.length) {
    const ch = source[j];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // 闭合之后允许有 ; 或其它尾巴；本测试只关心函数主体。
        return source.slice(head!.index, j + 1);
      }
    }
    // 跳过字符串字面量里的 `{` `}`。
    if (ch === "'" || ch === "\"" || ch === "`") {
      const quote = ch;
      let k = j + 1;
      while (k < source.length) {
        const c = source[k];
        if (c === "\\") { k += 2; continue; }
        if (c === quote) { k++; break; }
        if (c === "\n" && quote !== "`") break;
        k++;
      }
      j = k;
      continue;
    }
    j++;
  }
  return "";
}

test("actions/basic-info: uploadAndSaveManualCover 不再向 UI 索要 poi / description / minQuality", () => {
  const body = extractFunctionBody(actionsSource, "uploadAndSaveManualCover");
  assert.ok(body.length > 0, "未找到 uploadAndSaveManualCover 定义");
  assert.match(body, /file: \{ name: string; type: string; base64: string \}/);
  assert.doesNotMatch(body, /args\.poi/);
  assert.doesNotMatch(body, /args\.description/);
  assert.doesNotMatch(body, /args\.minQuality/);
  assert.match(actionsSource, /deriveManualCoverFields/);
});

test("actions/basic-info: saveCtripLibraryCover 接受 CtripLibraryImageCandidate 并自动推导三字段", () => {
  const body = extractFunctionBody(actionsSource, "saveCtripLibraryCover");
  assert.ok(body.length > 0, "未找到 saveCtripLibraryCover 定义");
  assert.match(body, /candidate: CtripLibraryImageCandidate/);
  assert.doesNotMatch(body, /CoverPlaceCandidate/);
  assert.match(body, /buildCtripLibraryCover\(args\.candidate\)/);
  const modelBody = extractFunctionBody(coverModelSource, "buildCtripLibraryCover");
  assert.match(modelBody, /source: "ctripLibrary"/);
  assert.match(modelBody, /minQuality:\s*3/);
});

test("actions/basic-info: saveCtripLibraryCover 写入 imageId / imageUrl 与可选字段", () => {
  const actionBody = extractFunctionBody(actionsSource, "saveCtripLibraryCover");
  const body = extractFunctionBody(coverModelSource, "buildCtripLibraryCover");
  assert.ok(actionBody.length > 0 && body.length > 0, "未找到封面保存 action 或领域转换函数");
  // imageId / imageUrl 直接从 candidate 透传。
  assert.match(body, /candidate\.imageId/);
  assert.match(body, /candidate\.imageUrl/);
  // 拒绝缺 imageId / imageUrl 时返回 false 且不调 updateReviewField。
  assert.match(body, /imageId 或 imageUrl|imageId\/imageUrl/);
  assert.match(actionBody, /setBasicInfoErrors/);
  assert.match(actionBody, /setNotice/);
  // 写入时把 imageId / imageUrl 放进 ProductCover，并保留可选字段。
  assert.match(body, /imageId,/);
  assert.match(body, /imageUrl,/);
  assert.match(body, /score/);
  assert.match(body, /resolution/);
  // 可选字段从 candidate.poiId / candidate.poiName 推导（不再是旧的 imageInfoPoi*）。
  assert.match(body, /candidate\.poiId/);
  assert.match(body, /candidate\.poiName/);
  assert.doesNotMatch(body, /imageInfoPoiId/);
  assert.doesNotMatch(body, /imageInfoPoiName/);
  // imageUrl 缺失时回退 previewUrl / thumbnailUrl：必须出现三个候选之间的 fallback。
  assert.match(body, /candidate\.imageUrl/);
  assert.match(body, /candidate\.previewUrl/);
  assert.match(body, /candidate\.thumbnailUrl/);
  // 选中时刻写 selectedAt（ISO 时间戳）。
  assert.match(body, /selectedAt:\s*new Date\(\)\.toISOString\(\)/);
  // 缺图时必须在纯转换层抛错，action catch 后不得调用 updateReviewField。
  const blockRe = /if\s*\(imageId\s*===\s*null\s*\|\|\s*imageUrl\s*===\s*null\)[\s\S]*?throw new Error\([^;]+;/;
  const block = body.match(blockRe);
  assert.ok(block, "缺 imageId/imageUrl 时必须在转换层抛错并跳过 updateReviewField");
  assert.doesNotMatch(block![0], /updateReviewField/);
});

test("actions/basic-info: saveCtripLibraryCover poi / description 使用 poiName 或携程图库兜底", () => {
  const body = extractFunctionBody(coverModelSource, "buildCtripLibraryCover");
  assert.ok(body.length > 0, "未找到 buildCtripLibraryCover 定义");
  // poi / description 以 poiName 为主，兑底 = `携程图库图片 ${imageId}`。
  assert.match(body, /candidate\.poiName \|\| fallbackLabel/);
  assert.match(body, /`携程图库图片 \$\{imageId\}`/);
  // poi / description 都不能是「携程图库图片」以外的默认文案（不能拿 candidate.label / detail 拼）。
  assert.doesNotMatch(body, /candidate\.label/);
  assert.doesNotMatch(body, /candidate\.detail/);
});
