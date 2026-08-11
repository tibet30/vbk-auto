/**
 * UI 静态断言：BasicInfoCoverRow 已精简为"紧凑工具条 + 候选列表"。
 *
 *   - 移除两个 coverSection 大块卡片：取而代之的 coverToolbar 是单行
 *     「选择图片 + 关键词输入 + 查询」组合；
 *   - 候选列表仍然限定固定高度并内部滚动，避免拉高 review 卡；
 *   - 已选 ctripLibrary cover 走 imageUrl，缺图走占位；
 *   - 候选 use 按钮在 imageId + imageUrl 都齐备时才可点，否则 disabled 并
 *     提示"未取到图片"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const coverRowPath = resolve(__dirname, "../../src/renderer/app/views/workspace/basic-info-cover-row.tsx");
const coverRowSource = readFileSync(coverRowPath, "utf8");
const coverRowStylePath = resolve(__dirname, "../../src/renderer/app/views/workspace/review-summary-basic-info.module.less");
const coverRowStyleSource = readFileSync(coverRowStylePath, "utf8");

/**
 * 去掉块注释 / 行注释 / JSDoc，再做"用户可见旧文案/旧输入"断言。
 * 同步处理 JSX/TS 内字符串字面量避免误剥注释起始符。
 */
function stripComments(source: string): string {
  let result = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) break;
      let next = end + 2;
      const newline = source.indexOf("\n", next);
      if (newline !== -1) next = newline + 1;
      i = next;
      continue;
    }
    if (two === "//") {
      const newline = source.indexOf("\n", i + 2);
      if (newline === -1) break;
      i = newline + 1;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") { j += 2; continue; }
        if (c === quote) { j++; break; }
        if (c === "\n" && quote !== "`") break;
        j++;
      }
      result += source.slice(i, j);
      i = j;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

const coverRowCode = stripComments(coverRowSource);

test("BasicInfoCoverRow 不再要求手动上传时填 POI / 描述 / 最低质量分", () => {
  assert.doesNotMatch(coverRowCode, /请先填写 POI 与描述/);
  assert.doesNotMatch(coverRowCode, /封面 POI/);
  assert.doesNotMatch(coverRowCode, /封面描述/);
  // cover.minQuality 在展示态仍读取(数据字段,不是输入框)。
  assert.doesNotMatch(coverRowCode, /最低质量分/);
  // 旧手动输入的 setState 全部下线。
  assert.doesNotMatch(coverRowCode, /setManualPoi|setManualDescription|setManualMinQuality/);
  // 旧的 props 不再带 poi/description/minQuality：
  assert.doesNotMatch(coverRowCode, /onUploadManual[^}]*poi/);
  assert.doesNotMatch(coverRowCode, /onUploadManual[^}]*description/);
  assert.doesNotMatch(coverRowCode, /onUploadManual[^}]*minQuality/);
});

test("BasicInfoCoverRow 携程图库查询只剩一个 scenic-name 输入框", () => {
  assert.doesNotMatch(coverRowCode, /请填写关键词与 POI/);
  assert.doesNotMatch(coverRowCode, /setSearchPoi/);
  assert.doesNotMatch(coverRowCode, /复用上方 POI/);
  assert.doesNotMatch(coverRowCode, /onSearchCtripLibrary\(\{ keyword, poi \}\)/);
  assert.doesNotMatch(coverRowCode, /onSearchCtripLibrary\(\{ imageIds/);
  assert.doesNotMatch(coverRowCode, /parseImageIds/);
  assert.doesNotMatch(coverRowCode, /ID_DELIMITER/);
  assert.doesNotMatch(coverRowCode, /CoverPlaceCandidate/);
  // 不接受图片 ID 输入：源码中不能出现「图片 ID」提示文案。
  assert.doesNotMatch(coverRowSource, /图片 ID/);
  assert.doesNotMatch(coverRowSource, /图片ID/);
  // 仅一个 scenic-name 输入框：placeholder / aria-label 必须是「景点名称」 / 「景点名」。
  const keywordInputs = coverRowCode.match(/aria-label="携程图库景点名称"/g) ?? [];
  assert.equal(keywordInputs.length, 1, "应当只有一个携程图库景点名称输入框");
  assert.match(coverRowCode, /placeholder="[^"]*景点名称[^"]*"/);
  assert.match(coverRowCode, /aria-label="携程图库景点名称"/);
});

test("BasicInfoCoverRow 选用 cover-search-keyword / cover-search-submit 暴露给 e2e", () => {
  assert.match(coverRowCode, /data-testid="cover-search-keyword"/);
  assert.match(coverRowCode, /data-testid="cover-search-submit"/);
  // 兼容旧链路已下线；阶段 A 错误改为 cover-place-error（涵盖「无匹配地址」分支）。
  assert.match(coverRowCode, /data-testid="cover-place-error"/);
  assert.match(coverRowCode, /data-testid="cover-place-select"/);
  assert.match(coverRowCode, /data-testid="cover-search-candidates"/);
  assert.match(coverRowCode, /data-testid="cover-candidate-pick"/);
});

test("BasicInfoCoverRow 地址候选 select 始终渲染，受控于 selectedPlace.stableId，选中后自动查询图片", () => {
  // select 始终渲染（不再用 !selectedPlace 条件包裹收起）。
  assert.match(coverRowCode, /<select\b/);
  assert.match(coverRowCode, /aria-label="携程图库地点候选"/);
  assert.doesNotMatch(coverRowCode, /!selectedPlace \? \(/);
  // select 必须用受控 value 绑定 selectedPlace.stableId，不能再用 defaultValue。
  assert.doesNotMatch(coverRowCode, /defaultValue=""/);
  assert.match(coverRowCode, /value=\{selectedPlace\?\.stableId \?\? ""\}/);
  // onChange / onPick / 阶段 B 自动查询 仍存在。
  assert.match(coverRowCode, /onChange=\{\(event\) => \{/);
  assert.match(coverRowCode, /if \(place\) onPick\(place\)/);
  assert.match(coverRowCode, /formatPlaceOption\(place\)/);
  assert.match(coverRowCode, /onSearchCtripLibraryImages\(\{ keyword, place \}\)/);
  assert.match(coverRowCode, /disabled=\{imageSearching \|\| saving\}/);
  // 「已选地址」摘要已被 select 自身取代：避免与 select 重复呈现同一信息。
  assert.doesNotMatch(coverRowCode, /data-testid="cover-selected-place"/);
  assert.doesNotMatch(coverRowCode, /已选地址/);
});

test("BasicInfoCoverRow 查询与上传在进行中不可重复触发", () => {
  assert.match(coverRowCode, /placeSearchInFlightRef/);
  assert.match(coverRowCode, /imageSearchInFlightRef/);
  assert.match(coverRowCode, /if \(placeSearchInFlightRef\.current \|\| imageSearchInFlightRef\.current \|\| saving \|\| uploading\) return;/);
  assert.match(coverRowCode, /if \(imageSearchInFlightRef\.current \|\| saving \|\| uploading\) return;/);
  assert.match(coverRowCode, /disabled=\{saving \|\| uploading \|\| placeSearching \|\| imageSearching\}/);
});

test("BasicInfoCoverRow 关键词变化会清除旧地点和图片候选", () => {
  assert.match(coverRowCode, /setSearchKeyword\(event\.target\.value\);[\s\S]*setPlaceResult\(null\);[\s\S]*setSelectedPlace\(null\);[\s\S]*setImageResult\(null\);/);
});

test("BasicInfoCoverRow 编辑态改为紧凑工具条，不再使用 coverSection 大块卡片", () => {
  // 新结构：coverToolbar（紧凑单行）。
  assert.match(coverRowCode, /coverToolbar/);
  // 旧结构两个 coverSection 必须消除。
  assert.doesNotMatch(coverRowCode, /coverSection\b/);
  assert.doesNotMatch(coverRowCode, /coverSectionTitle/);
  // 编辑态里 "选择图片并保存" 按钮必须仍在（手动上传路径）。
  assert.match(coverRowCode, /选择图片并保存/);
  // "查询" 按钮文本（精简版，旧版是 "查询候选"）。
  assert.match(coverRowCode, /查询/);
});

test("BasicInfoCoverRow CoverCandidates 使用 CtripLibraryImageCandidate 形状", () => {
  // 渲染候选依赖 imageId/imageUrl/quality/resolution，而非旧的 previewUrl / quality 字段族。
  assert.match(coverRowCode, /CtripLibraryImageCandidate/);
  assert.doesNotMatch(coverRowCode, /CoverPlaceCandidate/);
});

test("BasicInfoCoverRow CoverCandidates 渲染 imageUrl / loading=lazy + 占位 fallback", () => {
  // 渲染 imageUrl：有图直接走 <img> + lazy load。
  assert.match(coverRowCode, /candidate\.imageUrl/);
  assert.match(coverRowCode, /<img\b/);
  assert.match(coverRowCode, /loading="lazy"/);
  // 缺图时走占位元素，aria-hidden。
  assert.match(coverRowCode, /coverCandidatePlaceholder/);
});

test("BasicInfoCoverRow 候选 use 按钮在 imageId+imageUrl 缺失时 disabled 并显示「未取到图片」", () => {
  // 可点判定函数。
  assert.match(coverRowCode, /isCandidateSelectable/);
  // 按钮文本必须出现 "未取到图片"。
  assert.match(coverRowCode, /未取到图片/);
  // button 必须根据 selectable 状态切换 disabled / aria-disabled。
  assert.match(coverRowCode, /disabled=\{!selectable \|\| saving\}/);
  assert.match(coverRowCode, /aria-disabled=\{!selectable \|\| saving\}/);
});

test("BasicInfoCoverRow 已选 ctripLibrary cover 使用 imageUrl 渲染 + 显示 imageId / 质量 / 分辨率", () => {
  // 渲染 imageUrl 的分支必须存在。
  assert.match(coverRowCode, /cover\.imageUrl/);
  // 展示态渲染 imageId / score / resolution。
  assert.match(coverRowCode, /cover\.imageId/);
  assert.match(coverRowCode, /cover\.score/);
  assert.match(coverRowCode, /cover\.resolution/);
});

test("BasicInfoCoverRow manualUpload 预览走 data URL，不再声称 file:// / file 路径", () => {
  // manualUpload 预览依靠 cover.read 返回的 data URL（
  //  data:${mime};base64,...），文件丢失返回 null；不再走 file://。
  // 该断言覆盖 props JSDoc + 渲染策略 JSDoc，去除「file://」「file 路径」等老设护实调。
  assert.doesNotMatch(coverRowSource, /file:\s*\/\/\s*URL/);
  assert.doesNotMatch(coverRowSource, /file:\s*\/\/\s*路径/);
  assert.match(coverRowSource, /data URL/);
  assert.match(coverRowSource, /data:\s*\$\{mime\};base64,/);
});

test("BasicInfoCoverRow 提示文案仅使用「景点名称 / 景点名」，不接受图片 ID 输入", () => {
  // placeholder / hint 显式提及「景点名称」或「景点名」。
  assert.match(coverRowCode, /景点名称|景点名/);
  // 任何提示文案都不能接受图片 ID 输入。
  assert.doesNotMatch(coverRowCode, /图片\s*ID|imageId\s*输入|多个用逗号/);
  // “未取到图片” 的兑底文案引导用户换景点名称。
  assert.match(coverRowCode, /未取到图片，请换一个景点名称或确认携程图库是否有图/);
});

test("BasicInfoCoverRow 样式文件定义 select、coverCandidates 滚动容器 + 缩略图占位 + 工具条", () => {
  assert.match(coverRowStyleSource, /\.select\b/);
  // .coverCandidates 限定最大高度，避免候选过多时拉高整个 review 卡。
  assert.match(coverRowStyleSource, /\.coverCandidates\b/);
  assert.match(coverRowStyleSource, /max-height\s*:\s*260px|height\s*:\s*260px/);
  assert.match(coverRowStyleSource, /overflow-y\s*:\s*auto/);
  assert.match(coverRowStyleSource, /overscroll-behavior\s*:\s*contain/);
  // 缩略图 + 占位 + 工具条都要具备。
  assert.match(coverRowStyleSource, /\.coverCandidateThumb\b/);
  assert.match(coverRowStyleSource, /\.coverCandidatePlaceholder\b/);
  assert.match(coverRowStyleSource, /\.coverToolbar\b/);
  // 旧 coverSection 样式必须清除。
  assert.doesNotMatch(coverRowStyleSource, /\.coverSection\b/);
});
