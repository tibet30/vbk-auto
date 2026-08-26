/**
 * 基础信息模块"始终展示"契约的源码级静态断言：
 *  - 父组件 review-summary-basic-info.tsx 的核心行（封面 / 副标题 / 管家 /
 *    400 电话 / 套餐定价 / 班期库存）必须**无条件**挂载，不再按 servicePhone / adult /
 *    subtitle 的非空条件挂载；
 *  - 旧的"条件挂载"标记（subtitleVisible / servicePhoneVisible /
 *    pricingVisible）必须从源码中消失；
 *  - 定价行 / 400 电话行必须接受 null 输入并落到空态分支；
 *  - headMeta 文案必须能反映「待补充 / 待设置」状态。
 *
 * 测试不依赖 DOM 渲染（产品无 DOM 测试基础设施），用正则定位源码做
 * 「应当出现」「必须消失」的字符串断言，足以在静态层面锁住契约。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workspaceDir = resolve(__dirname, "../../src/renderer/app/views/workspace");

const parentPath = resolve(workspaceDir, "review-summary-basic-info.tsx");
const pricingPath = resolve(workspaceDir, "basic-info-pricing-row.tsx");
const inventoryPath = resolve(workspaceDir, "basic-info-inventory-row.tsx");
const servicePhonePath = resolve(workspaceDir, "basic-info-service-phone-row.tsx");
const butlerPath = resolve(workspaceDir, "basic-info-butler-row.tsx");
const subtitlePath = resolve(workspaceDir, "basic-info-subtitle-row.tsx");
const moduleCssPath = resolve(workspaceDir, "review-summary-basic-info.module.less");

const parentSource = readFileSync(parentPath, "utf8");
const pricingSource = readFileSync(pricingPath, "utf8");
const inventorySource = readFileSync(inventoryPath, "utf8");
const servicePhoneSource = readFileSync(servicePhonePath, "utf8");
const butlerSource = readFileSync(butlerPath, "utf8");
const subtitleSource = readFileSync(subtitlePath, "utf8");
const moduleCssSource = readFileSync(moduleCssPath, "utf8");

/** 去掉块注释 / 行注释 / 字符串字面量，避免 JSX/JS 内字符串干扰断言。 */
function stripCommentsAndStrings(source: string): string {
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
      result += " ";
      i = j;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

test("父组件 review-summary-basic-info 始终挂载封面 / 副标题 / 管家 / 400 电话 / 套餐定价 / 班期库存", () => {
  const code = stripCommentsAndStrings(parentSource);
  // JSX 节点必须直接出现在 body 内，不允许外面套任何 servicePhone 非空/phone 长度条件。
  assert.match(code, /<BasicInfoCoverRow\b/);
  assert.match(code, /<BasicInfoSubtitleRow\b/);
  assert.match(code, /<BasicInfoButlerRow\b/);
  assert.match(code, /<BasicInfoServicePhoneRow\b/);
  assert.match(code, /<BasicInfoPricingRow\b/);
  assert.match(code, /<BasicInfoInventoryRow\b/);
  // 用车资源组保持既有产品类型条件挂载（vehicleVisible 三元）。
  assert.match(code, /vehicleVisible\s*\?\s*[\s\S]*?<BasicInfoVehicleRow\b[\s\S]*?:\s*null/);
});

test("父组件不再用 servicePhone / adult / subtitle 的非空条件挂载各行", () => {
  const code = stripCommentsAndStrings(parentSource);
  // 旧条件挂载标记必须消失：subtitleVisible / servicePhoneVisible / pricingVisible。
  assert.doesNotMatch(code, /subtitleVisible/);
  assert.doesNotMatch(code, /servicePhoneVisible/);
  assert.doesNotMatch(code, /pricingVisible/);
  // 子标题行的挂载处不能被某判断包住。
  const subtitleMounted = /<BasicInfoSubtitleRow\b[\s\S]*?\/>/.exec(parentSource);
  assert.ok(subtitleMounted, "应当找到 BasicInfoSubtitleRow 挂载点");
  // 套餐定价行同样不能被某判断包住。
  const pricingMounted = /<BasicInfoPricingRow\b[\s\S]*?\/>/.exec(parentSource);
  assert.ok(pricingMounted, "应当找到 BasicInfoPricingRow 挂载点");
  const inventoryMounted = /<BasicInfoInventoryRow\b[\s\S]*?\/>/.exec(parentSource);
  assert.ok(inventoryMounted, "应当找到 BasicInfoInventoryRow 挂载点");
});

test("父组件 headMeta 在缺失字段时使用「待补充 / 待设置」文案", () => {
  assert.match(parentSource, /副标题待补充/);
  assert.match(parentSource, /管家待补充/);
  assert.match(parentSource, /400 电话待设置/);
  assert.match(parentSource, /定价待设置/);
  assert.match(parentSource, /库存待设置/);
  assert.match(parentSource, /用车待匹配/);
});

test("BasicInfoInventoryRow 接受 null 并沿用 parseInventoryDraft 校验", () => {
  const code = stripCommentsAndStrings(inventorySource);
  assert.match(code, /startDate:\s*string\s*\|\s*null/);
  assert.match(code, /endDate:\s*string\s*\|\s*null/);
  assert.match(code, /dailyQuota:\s*number\s*\|\s*null/);
  assert.match(code, /hasValue\s*=\s*startDate\s*!==\s*null\s*&&\s*endDate\s*!==\s*null\s*&&\s*dailyQuota\s*!==\s*null/);
  assert.match(code, /parseInventoryDraft\(\s*draft\.startDate\s*,\s*draft\.endDate\s*,\s*draft\.dailyQuota\s*\)/);
  assert.match(code, /canSave\s*=\s*parsed\s*!==\s*null/);
  assert.match(inventorySource, /commercial\.inventory/);
  assert.match(inventorySource, /type="date"/);
});

test("BasicInfoPricingRow 接受 adult/child/minimumTravelers 为 null，并跳过数值格式化", () => {
  const code = stripCommentsAndStrings(pricingSource);
  // 接口签名必须显式声明 adult / child / minimumTravelers 为 number | null。
  assert.match(code, /adult:\s*number\s*\|\s*null/);
  assert.match(code, /child:\s*number\s*\|\s*null/);
  assert.match(code, /minimumTravelers:\s*number\s*\|\s*null/);
  // hasValue 三字段同时非空才展示数值；任一缺失走空状态。
  assert.match(code, /hasValue\s*=\s*adult\s*!==\s*null\s*&&\s*child\s*!==\s*null\s*&&\s*minimumTravelers\s*!==\s*null/);
  // 展示态直接调 toLocaleString（已被 hasValue 三字段守卫保护）。
  assert.match(code, /child\.toLocaleString/);
  assert.match(code, /minimumTravelers\.toLocaleString/);
  // draft 初值必须走 toDraftString(null) = ""，不能在 null 上调 String(number)。
  // stripCommentsAndStrings 把字符串字面量都替换成空格，所以 "" 会消失，要容忍 \s+。
  assert.match(code, /function\s+toDraftString[\s\S]*?null\s*\?\s*\s*:\s*String\(value\)/);
  // persisted 必须包含三字段的 toDraftString(...) 初值。
  assert.match(code, /persisted\s*=\s*\{\s*adult:\s*toDraftString\(adult\)[\s\S]*?child:\s*toDraftString\(child\)[\s\S]*?minimumTravelers:\s*toDraftString\(minimumTravelers\)[\s\S]*?\}/);
  // 编辑初始 draft 不调 toLocaleString：必须不存在 persisted.*.toLocaleString 形态。
  assert.doesNotMatch(code, /persisted\.adult\.toLocaleString/);
  assert.doesNotMatch(code, /persisted\.child\.toLocaleString/);
  assert.doesNotMatch(code, /persisted\.minimumTravelers\.toLocaleString/);
});

test("BasicInfoPricingRow 校验沿用 parsePricingDraft：成人 > 0、儿童 >= 0、起订人数正整数", () => {
  const code = stripCommentsAndStrings(pricingSource);
  // 复用 helper 校验：canSave = parsed !== null。
  assert.match(code, /parsePricingDraft\(\s*draft\.adult\s*,\s*draft\.child\s*,\s*draft\.minimumTravelers\s*\)/);
  assert.match(code, /canSave\s*=\s*parsed\s*!==\s*null/);
  // 保存按钮按 canSave 切 primary/ghost + disabled（字符串字面量已被 strip，留空白）。
  assert.match(code, /data-variant=\{canSave\s*\?\s*\s*:\s*\s*\}/);
  assert.match(code, /disabled=\{saving\s*\|\|\s*!canSave\}/);
  // 不默认填 minimumTravelers —— 不能出现 ?? 1、|| 1、Number(...) 之类的默认值兑底。
  assert.doesNotMatch(code, /minimumTravelers\s*\?\?\s*1/);
  assert.doesNotMatch(code, /minimumTravelers\s*\|\|\s*1/);
});

test("BasicInfoServicePhoneRow 接受 null / 空串输入并落到「未设置」空态", () => {
  const code = stripCommentsAndStrings(servicePhoneSource);
  // 接口签名：servicePhone 为 string | null。
  assert.match(code, /servicePhone:\s*string\s*\|\s*null/);
  // normalizePhone 把 null / 空串归一为 null。
  assert.match(code, /function\s+normalizePhone[\s\S]*?trimmed\.length\s*>\s*0\s*\?\s*trimmed\s*:\s*null/);
  // 有值展示账号已配，无值展示未设置。
  // 字符串字面量被 strip 成空格，需对中文部分做空白容忍匹配。
  assert.match(code, /normalized\s*\?\s*[\s\S]*?账号已配[\s\S]*?:\s*[\s\S]*?未设置/);
  assert.match(servicePhoneSource, /data-tone="warn"/);
  assert.doesNotMatch(code, /onOpenAccountEditor|去账号设置|Settings/);
});

test("BasicInfoButlerRow 接受 null 快照并只读展示账号默认联系人", () => {
  const code = stripCommentsAndStrings(butlerSource);
  // snapshotButler 必须是 ContactCardSelection | null。
  assert.match(code, /snapshotButler:\s*ContactCardSelection\s*\|\s*null/);
  assert.match(code, /displayButler\s*=\s*accountButlerDefault\s*\?\?\s*snapshotButler/);
  assert.match(butlerSource, /账号默认/);
  assert.doesNotMatch(code, /onUseAccountButler|onClearButler|onOpenAccountEditor|清除|使用账号默认/);
});

test("BasicInfoSubtitleRow 默认展示「尚未填写」空状态，不再仅按非空挂载", () => {
  // displayValue 包含「尚未填写」兜底文案。中文落在字符串字面量内，要直接读原文。
  assert.match(subtitleSource, /尚未填写/);
  // 始终挂载 input 切换逻辑由 isEditing 状态控制，persisted 缺失也可进入编辑态。
  const code = stripCommentsAndStrings(subtitleSource);
  assert.match(code, /persisted\s*=\s*snapshot\.subtitle\s*\?\?\s*\s*/);
});

test("review-summary-basic-info.module.less 包含 .priceSeparator 与 .tag[data-tone=warn] 等共享样式", () => {
  assert.match(moduleCssSource, /\.priceSeparator\b/);
  assert.match(moduleCssSource, /\.tag\[data-tone='warn'\]|\.tag\[data-tone="warn"\]/);
  assert.match(moduleCssSource, /\.hint\b/);
  // 行壳不引入 max-height 锁定，保持自然高度。
  assert.doesNotMatch(moduleCssSource, /\.row\s*\{[^}]*max-height/);
});

test(".inputGroup 单行紧凑展示三输入：grid 三列 + 子项 min-width:0 防止溢出", () => {
  // 提取 .inputGroup 块定义（含嵌套规则），防止误匹配同名变量/类。
  const block = /\.inputGroup\s*\{[\s\S]*?\n\}/.exec(moduleCssSource);
  assert.ok(block, "应当找到 .inputGroup 样式块");
  const def = block[0];
  // 必须显式三列：repeat(3, minmax(0, 1fr)) 或等价的三个 minmax(0, 1fr) 写法。
  assert.match(
    def,
    /grid-template-columns\s*:\s*repeat\(\s*3\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)/,
    ".inputGroup 必须使用 repeat(3, minmax(0, 1fr)) 单行三列紧凑布局，禁止再退化为两列 1fr 1fr",
  );
  // .inputGroup 自身必须 min-width: 0：作为父级 grid 的中间列子项时不会被
  // 内容撑大，让三列能稳定保持「单行」而不是溢出换行。
  assert.match(
    def,
    /min-width\s*:\s*0\b/,
    ".inputGroup 必须显式 min-width: 0，避免父级 grid 中间列被内容撑大造成溢出",
  );
  // 子项 .priceLabel 必须显式 min-width: 0，阻断 input intrinsic min-width 撑破 grid 单元。
  const priceLabelBlock = /\.priceLabel\s*\{[\s\S]*?\n\}/.exec(moduleCssSource);
  assert.ok(priceLabelBlock, "应当找到 .priceLabel 样式块");
  assert.match(
    priceLabelBlock[0],
    /min-width\s*:\s*0\b/,
    ".priceLabel 必须 min-width: 0，避免 number input 把 grid 单元撑大造成溢出",
  );
  // 旧的固定 max-width 限制必须消失 —— 360px 上限会导致窄 .rowValue 下三列
  // 被挤压到内容溢出、三个 input 换行的回归。
  assert.doesNotMatch(
    def,
    /max-width\s*:\s*360px\b/,
    ".inputGroup 不应再以 max-width: 360px 锁定总宽，避免三个输入被挤压换行",
  );
  // 旧的两列布局必须消失。
  assert.doesNotMatch(
    moduleCssSource,
    /\.inputGroup\s*\{[^}]*grid-template-columns\s*:\s*1fr\s+1fr\b/,
    ".inputGroup 不应再使用 1fr 1fr 两列布局",
  );
});
