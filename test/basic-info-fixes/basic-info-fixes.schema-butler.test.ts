// 固定联系人 1368298 不存在场景（真实 run 09306ec1）安全防护
//
// 真实 run 09306ec1 的 basic 阶段因账号固定联系人「安思科」(ID 1368298) 在
// VBK 列表里不存在而进入 needs_user；安全修复要求：
//   1) findButlerOptionIndex 在 byId 失败时不能落到 byName 回退（除非 VBK
//      整列都未提供 value），否则会静默把同姓名的另一张卡选成新负责人；
//   2) fillButlerContact 必须显式抛错，而不是回退到「默认第一项」；
//   3) 错误信息必须明确指出 contactCardId + displayName + 可选列表，便于
//      运营一眼定位是「联系人被 VBK 移除」还是「同姓名误选」。
//
// 本文件仅承载本任务新增的 butler 安全契约测试；原 schema 测试请见
// basic-info-fixes.schema.test.ts，避免与既有用户改动相互覆盖。

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assert,
  findButlerOptionIndex,
  test,
} from "./basic-info-fixes.shared.js";

test("findButlerOptionIndex byName 回退在 VBK 已提供其他 ID 时禁用，避免同姓名误选", () => {
  // 真实 run 09306ec1 复现：固定联系人「安思科」ID 1368298 在 VBK 列表里
  // 已不存在，但同姓名的另一张卡（ID 999）仍存在。旧实现会走 byName 回退
  // 把「安思科-999」选成新的负责人，造成静默误选。新实现只要 VBK 提供了
  // 任何非空 value，就立即 -1，让 fillButlerContact 显式抛错。
  const index = findButlerOptionIndex(
    [
      { value: "100", label: "其他用户" },
      { value: "999", label: "安思科 ansike@qq.com +86 15910250965" },
    ],
    { contactCardId: 1368298, displayName: "安思科" },
  );
  assert.equal(index, -1, "byName 回退在 VBK 提供其他 ID 时必须禁用，绝不误选同姓名联系人");
});

test("findButlerOptionIndex 固定联系人 1368298 不在 VBK 列表时返回 -1（不误选同姓名）", () => {
  // 真实场景：账号固定联系人「安思科」ID 1368298 在 VBK 列表里已不存在，
  // 但同姓名的「安思科」(ID 999) 仍在。安全修复后必须返回 -1，让上层
  // 显式抛错而不是把 ID 999 选成新的负责人。
  const index = findButlerOptionIndex(
    [
      { value: "100", label: "其他用户1 13800138001" },
      { value: "999", label: "安思科 ansike@qq.com +86 15910250965" },
    ],
    { contactCardId: 1368298, displayName: "安思科" },
  );
  assert.equal(index, -1, "固定联系人 1368298 不在 VBK 列表时必须返回 -1，绝不误选同姓名联系人");
});

test("findButlerOptionIndex 固定联系人 1368298 列表中完全无同名时返回 -1", () => {
  // 真实场景：固定联系人「安思科」ID 1368298 在 VBK 列表里已不存在，
  // 且列表里也没有任何同名联系人。安全修复后必须返回 -1，让上层抛错。
  const index = findButlerOptionIndex(
    [
      { value: "100", label: "其他用户1 13800138001" },
      { value: "200", label: "其他用户2 13800138002" },
    ],
    { contactCardId: 1368298, displayName: "安思科" },
  );
  assert.equal(index, -1, "固定联系人 1368298 完全不在 VBK 列表时必须返回 -1");
});

test("findButlerOptionIndex 固定联系人 1368298 在列表中且 ID 命中时正常返回", () => {
  // 反向验证：只要 VBK 列表里真的存在 ID 1368298，必须按 ID 精确匹配；
  // 不能因为 byName 安全门而拒绝正确的命中。
  const index = findButlerOptionIndex(
    [
      { value: "100", label: "其他用户" },
      { value: "1368298", label: "安思科 ansike@qq.com +86 15910250965" },
    ],
    { contactCardId: 1368298, displayName: "安思科" },
  );
  assert.equal(index, 1, "固定联系人 1368298 真实存在时必须按 ID 精确命中");
});

test("findButlerOptionIndex VBK 整列无 value 且同姓名存在时仍允许 byName 回退", () => {
  // VBK 退化下拉：整列都未提供 value（没有 contactCardId）。此时按姓名
  // 回退是合理且安全的（VBK 没有给 ID，我们只能按姓名选），不应该被
  // 安全门误伤。
  const index = findButlerOptionIndex(
    [
      { value: "", label: "其他用户 13800138001" },
      { value: "", label: "安思科 ansike@qq.com +86 15910250965" },
    ],
    { contactCardId: 1368298, displayName: "安思科" },
  );
  assert.equal(index, 1, "VBK 退化下拉（整列无 value）时必须允许 byName 回退");
});

// fillButlerContact 源码契约测试：直接读取 sections.ts 然后切出
// fillButlerContact 函数体，避免 readSourceTree 跨文件拼接带来的边界
// 不确定问题。
function readFillButlerContactBody(): string {
  // 走 process.cwd() + path.resolve，避免 new URL(relative, import.meta.url)
  // 在 tsx/node:test 加载边界下偶发 ERR_INVALID_URL。CWD 始终是仓库根目录
  // （npm test / npx tsx --test 等入口都已锚定），path.resolve 拿到绝对路径
  // 后 fs.readFileSync 100% 可靠。
  const sectionsPath = path.resolve(
    process.cwd(),
    "src",
    "main",
    "automation",
    "ctrip",
    "basic-info",
    "sections.ts",
  );
  const source = readFileSync(sectionsPath, "utf8");
  const start = source.indexOf("async function fillButlerContact");
  assert.ok(start >= 0, "找不到 fillButlerContact 定义");
  // 函数体直到下一个 `(export )?async function` 或文件末尾。
  const tail = source.slice(start + 1);
  const nextAnchor = tail.search(/\n\s*(?:export\s+)?async\s+function\s+/);
  const end = nextAnchor >= 0 ? start + 1 + nextAnchor : source.length;
  return source.slice(start, end);
}

test("fillButlerContact 源码绝不调用 findFirstEnabledOptionIndex 作为误选兜底", () => {
  // 真实 run 09306ec1 复现的安全契约：fillButlerContact 在 ID / 姓名
  // 都没命中时，必须显式抛错，绝不能回退到「选第一个 enabled 的选项」。
  // 这种「默认第一项」是基本信息的典型误选路径，必须用源码断言锁死。
  const body = readFillButlerContactBody();
  // 函数体内不允许出现 findFirstEnabledOptionIndex 调用。
  assert.ok(
    !/findFirstEnabledOptionIndex\s*\(/.test(body),
    "fillButlerContact 内部绝不能调用 findFirstEnabledOptionIndex 作为误选兜底",
  );
});

test("fillButlerContact 错误信息必须包含 contactCardId / displayName / 可选列表", () => {
  // 真实 run 09306ec1 失败恢复时，recovery 链只能拿到 fillButlerContact
  // 抛出的 message。错误信息必须明确指出 contactCardId + displayName +
  // 可选列表，便于运营一眼定位是「联系人被 VBK 移除」还是「同姓名误选」。
  const body = readFillButlerContactBody();
  // 错误文案必须同时携带 contactCardId、displayName（若有）、可选列表。
  assert.match(body, /\$\{contactCardId\}/, "错误信息必须显式携带 contactCardId");
  assert.match(body, /\$\{displayName\}/, "错误信息必须显式携带 displayName");
  assert.match(body, /可选[：:]/, "错误信息必须列出可选列表供运营核对");
  // 必须明确指引「在 VBK 维护该联系人或更新账号固定信息后重试」。
  assert.match(body, /在 VBK 维护该联系人或更新账号固定信息/);
});

test("fillButlerContact 错误信息包含可操作的修复提示", () => {
  // 当管家联系人在 VBK 下拉里完全找不到时，错误信息必须：
  //   1) 说明是哪个联系人缺失（含 ID + 姓名）；
  //   2) 明确给出修复路径（在 VBK 维护 / 更新账号固定信息）；
  //   3) 不混淆使用「可选」列表 —— 那些候选都不是同一个联系人。
  const body = readFillButlerContactBody();
  assert.match(body, /不在 VBK 联系人下拉中/, "fillButlerContact 必须说明联系人不在下拉中");
  assert.match(body, /请在 VBK 维护该联系人或更新账号固定信息/, "fillButlerContact 必须给出可操作的修复提示");
  assert.match(body, /可选：/, "fillButlerContact 仍附带候选列表供运营排查");
});