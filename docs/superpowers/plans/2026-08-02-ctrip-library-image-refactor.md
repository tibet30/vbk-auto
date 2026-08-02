# 携程图库选图通用化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/main/automation/ctrip.ts` 里现封装的封面图库导入流程抽出为可复用的 `selectCtripLibraryImage` 通用模块,并改用显式等待替代 `delay()` 轮询。

**Architecture:** 通用模块只与图库弹窗 UI 交互,接收 `LibraryImageParams` 参数,不持有产品 JSON 知识;`selectCtripLibraryCover` 改为调用通用模块,负责定位封面 `addCard` 与封面落位验证。所有关键交互用 `waitFor({ state, timeout })`,0 张匹配图明确报错而非静默选第一张。

**Tech Stack:** Playwright 1.62 (Chromium + locators) · TypeScript 7 · Node `node:test` 测试运行器。

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `src/main/automation/schema.ts` | 修改 | `findBestCtripLibraryImage` 增加可选 `aspect` 参数(`'landscape' \| 'any'`) |
| `src/main/automation/ctrip.ts` | 修改 | 新增 `LibraryImageAspect`/`LibraryImageParams` 类型与 `selectCtripLibraryImage`;`selectCtripLibraryCover` 改为内部调用通用模块;等待策略显式化 |
| `test/schema.test.ts` | 修改 | 现有 `findBestCtripLibraryImage` 测试调整为传新参数;新增 `aspect: 'any'` 用例 |
| `test/library-image.test.ts` | 新增 | Playwright 集成测试,启动 Chromium 加载模拟图库 HTML,验证 4 个场景 |
| `test/library-image-fixture.html` | 新增 | 模拟图库弹窗的静态 HTML,用于集成测试 |

---

## Task 1: 为 `findBestCtripLibraryImage` 增加 `aspect` 参数

**Files:**
- Modify: `src/main/automation/schema.ts:190-208`
- Modify: `test/schema.test.ts:37-54`

**Interfaces:**
- Consumes: 既有调用方继续传 2 个参数(向后兼容);新参数默认值需保持现有行为
- Produces: `findBestCtripLibraryImage(images, minQuality, aspect = 'landscape')` 在 aspect 缺省时行为不变

### 步骤

- [ ] **Step 1: 写失败测试**

在 `test/schema.test.ts` 末尾追加:

```ts
test("携程图库选图 aspect:'any' 时允许竖版图片", () => {
  const index = findBestCtripLibraryImage([
    { quality: "3.0-3.8", resolution: "800 * 1400" },
    { quality: "3.6-4.9", resolution: "3000 * 1999" },
    { quality: "3.2-3.9", resolution: "1200 * 900" },
  ], 3, "any");

  assert.equal(index, 2);
});

test("携程图库选图 aspect:'landscape' 时拒绝竖版(默认行为)", () => {
  assert.equal(findBestCtripLibraryImage([
    { quality: "4.0", resolution: "800 * 1200" },
  ], 3, "landscape"), -1);
});

test("携程图库选图 aspect:'any' 时分辨率不达标仍被拒", () => {
  assert.equal(findBestCtripLibraryImage([
    { quality: "4.0", resolution: "100 * 100" },
  ], 3, "any"), -1);
});
```

- [ ] **Step 2: 跑测试,确认第一条失败**

```bash
npx tsx --test test/schema.test.ts -t "aspect"
```

预期:第一条 `aspect:'any'` 失败(因为函数签名只接受 2 个参数)。

- [ ] **Step 3: 修改 `findBestCtripLibraryImage` 增加 aspect 参数**

修改 `src/main/automation/schema.ts:190` 的函数实现:

```ts
export type CtripLibraryImageAspect = "landscape" | "any";

export function findBestCtripLibraryImage(
  images: ReadonlyArray<{ quality: string; resolution: string }>,
  minQuality: number,
  aspect: CtripLibraryImageAspect = "landscape",
) {
  let bestIndex = -1;
  let bestQuality = -Infinity;
  images.forEach((image, index) => {
    const qualities = image.quality.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    const lowestQuality = qualities.length ? Math.min(...qualities) : -Infinity;
    const dimensions = image.resolution.match(/\d+/g)?.map(Number) || [];
    const [width = 0, height = 0] = dimensions;
    if (lowestQuality < minQuality || width < 1280 || height < 800) return;
    if (aspect === "landscape" && width < height) return;
    if (lowestQuality > bestQuality) {
      bestQuality = lowestQuality;
      bestIndex = index;
    }
  });
  return bestIndex;
}
```

**注意:** 把原 `width < 1280 || height < 800` 提到 aspect 判断之前,这样 `aspect: 'any'` 仍然只接受 ≥1280×800 的最小分辨率(只在方向上放宽)。如果需要让 `'any'` 真正不限尺寸,把 `|| width < 1280 || height < 800` 这一行也按 aspect 分支处理。**已确认:** spec 说"封面默认 1280×800,路线/特色等可 any" — 公共最低分辨率仍按 1280×800,只在是否要求横版上放宽。

- [ ] **Step 4: 跑测试确认全部通过**

```bash
npx tsx --test test/schema.test.ts
```

预期:所有现有用例 + 3 个新增用例全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/main/automation/schema.ts test/schema.test.ts
git commit -m "feat(schema): findBestCtripLibraryImage 支持 aspect 参数"
```

---

## Task 2: 抽出通用模块 `selectCtripLibraryImage` 及集成测试

**Files:**
- Modify: `src/main/automation/ctrip.ts:1`(顶部 import 新增类型)
- Create: `test/library-image-fixture.html`
- Create: `test/library-image.test.ts`

**Interfaces:**
- Consumes: `findBestCtripLibraryImage` 与 `LibraryImageAspect`(Task 1)
- Produces: `LibraryImageParams` 类型 + `selectCtripLibraryImage(page, params)` 通用函数。该函数由 Task 3 的 `selectCtripLibraryCover` 调用。

### 步骤

- [ ] **Step 1: 创建 `test/library-image-fixture.html`**

文档结构必须与 VBK 真实图库弹窗一致(trigger 卡片 → "图库导入" 链接 → 弹窗 → POI 下拉 → 描述输入 → 查询按钮 → 结果卡片数组 → 协议 → 同意并导入)。脚本能根据 URL hash 切换场景:

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>图库弹窗测试 fixture</title></head>
<body>
<style>
  body { font-family: system-ui, sans-serif; padding: 24px; }
  .card { position: relative; border: 1px dashed #ccc; padding: 16px; margin-bottom: 16px; width: 200px; }
  .img-import-link { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.6); color: white; cursor: pointer; }
  .card:hover .img-import-link { display: flex; }
  .dialog-mask { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; align-items: center; justify-content: center; }
  .dialog-mask.open { display: flex; }
  .dialog { background: white; padding: 24px; min-width: 600px; }
  .grid { display: grid; grid-template-columns: 200px 1fr; gap: 8px; margin-bottom: 12px; }
  label { text-align: right; align-self: center; }
  .picitem { display: flex; gap: 8px; padding: 8px; border: 1px solid #ddd; cursor: pointer; }
  .picitem.selected { border-color: #1677ff; background: #e6f4ff; }
  .empty-tip { color: #999; padding: 16px; text-align: center; }
</style>

<div class="card" id="trigger-card">
  <div class="placeholder">添加图片</div>
  <div class="img-import-link" id="img-import-link">图库导入</div>
</div>

<div class="dialog-mask" id="dialog-mask">
  <div class="dialog" role="dialog" aria-label="从图库资源导入">
    <h2>从图库资源导入</h2>
    <div class="grid">
      <label>图片渠道</label>
      <input id="source" value="供应商图库" readonly />
      <label>景区/城市</label>
      <input id="city" />
      <label>景点</label>
      <div tabindex="0" id="PoiId" role="combobox" aria-controls="poi-list" aria-expanded="false">
        <input />
      </div>
    </div>
    <ul id="poi-list" role="listbox" style="display:none;"></ul>
    <div class="grid">
      <label>描述</label>
      <input id="description" />
    </div>
    <button id="query-btn">查询</button>
    <button id="confirm-btn">同意并导入</button>
    <div id="results"></div>
    <label><input type="checkbox" id="agreement" />我已仔细阅读并同意《使用协议》</label>
  </div>
</div>

<script>
  // 根据 hash 切换场景
  const scenario = location.hash.slice(1) || 'happy';
  const mask = document.getElementById('dialog-mask');
  const results = document.getElementById('results');
  const poiList = document.getElementById('poi-list');
  const poiInput = document.querySelector('#PoiId input');
  const confirmBtn = document.getElementById('confirm-btn');
  const trigger = document.getElementById('trigger-card');

  trigger.addEventListener('click', (e) => {
    if (e.target.id === 'img-import-link') {
      mask.classList.add('open');
      // POI 选项默认填充:"晋祠博物馆"
      poiList.innerHTML = '<li role="option" data-value="1">晋祠博物馆</li>';
      poiList.querySelector('li').addEventListener('click', () => {
        poiInput.value = '晋祠博物馆';
        poiList.style.display = 'none';
      });
    }
  });

  // 默认 POI 下拉点击"晋祠博物馆" 也用作通用 selectSearchOption 测试
  poiInput.addEventListener('focus', () => { poiList.style.display = 'block'; });

  document.getElementById('query-btn').addEventListener('click', () => {
    results.innerHTML = '';
    if (scenario === 'empty') {
      results.innerHTML = '<div class="empty-tip">未找到符合条件的图片</div>';
      return;
    }
    if (scenario === 'no-poi') {
      poiList.innerHTML = ''; // POI 列表为空
      return;
    }
    const data = [
      { quality: '3.0-3.8', resolution: '800 * 1400', selected: false },
      { quality: '3.6-4.9', resolution: '3000 * 1999', selected: false },
      { quality: '3.2-3.9', resolution: '1200 * 900', selected: false },
      { quality: '4.5', resolution: '800 * 800', selected: false }, // 横版不合格
    ];
    data.forEach((d, i) => {
      const el = document.createElement('div');
      el.className = 'picitem';
      el.dataset.index = String(i);
      el.innerHTML = `<span>质量分：${d.quality}</span><span>分辨率：${d.resolution}</span>`;
      el.addEventListener('click', () => {
        results.querySelectorAll('.picitem').forEach(n => n.classList.remove('selected'));
        el.classList.add('selected');
        window.__selectedIndex = i;
      });
      results.appendChild(el);
    });
  });

  confirmBtn.addEventListener('click', () => {
    if (scenario === 'happy' || scenario === 'empty' || scenario === 'no-poi') {
      mask.classList.remove('open');
      window.__dialogClosed = true;
    }
  });
</script>
</body>
</html>
```

保存到 `test/library-image-fixture.html`(git 跟踪)。

- [ ] **Step 2: 写失败测试 `test/library-image.test.ts`**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import {
  selectCtripLibraryImage,
  type LibraryImageParams,
} from "../src/main/automation/ctrip.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = `file://${path.join(HERE, "library-image-fixture.html")}`;

async function boot(scenario: "happy" | "empty" | "no-poi") {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${FIXTURE}#${scenario}`);
  return { browser, ctx, page };
}

async function baseParams(page: any): Promise<LibraryImageParams> {
  return {
    trigger: page.locator("#trigger-card"),
    poi: "晋祠博物馆",
    minQuality: 3,
    aspect: "landscape",
    label: "封面",
  };
}

test("selectCtripLibraryImage happy: 选中并触发弹窗关闭", async () => {
  const { browser, page } = await boot("happy");
  try {
    const result = await selectCtripLibraryImage(page, await baseParams(page));
    assert.equal(result.reused, false);
    assert.equal(await page.locator(".dialog-mask.open").count(), 0);
    assert.equal(await page.evaluate(() => window.__selectedIndex), 2);
  } finally {
    await browser.close();
  }
});

test("selectCtripLibraryImage 0 张匹配图抛错并不自动选", async () => {
  const { browser, page } = await boot("empty");
  try {
    await assert.rejects(
      () => selectCtripLibraryImage(page, await baseParams(page)),
      /未找到符合质量要求的图片/,
    );
    assert.equal(await page.evaluate(() => window.__selectedIndex), undefined);
  } finally {
    await browser.close();
  }
});

test("selectCtripLibraryImage POI 不存在抛错", async () => {
  const { browser, page } = await boot("no-poi");
  try {
    await assert.rejects(
      () => selectCtripLibraryImage(page, await baseParams(page)),
      /未找到/,
    );
  } finally {
    await browser.close();
  }
});
```

- [ ] **Step 3: 跑测试确认全部失败(undefined function)**

```bash
npx tsx --test test/library-image.test.ts
```

预期:失败,提示 `selectCtripLibraryImage` 未导出。

- [ ] **Step 4: 在 `ctrip.ts` 中实现类型与函数**

在文件顶部(已有 `findBestCtripLibraryImage` 的 import 上方)追加类型导入:

```ts
import { findBestCtripLibraryImage, type CtripLibraryImageAspect } from "./schema.js";
```

在文件中段合适位置(现有 `selectCtripLibraryCover` 上方)新增:

```ts
export type { CtripLibraryImageAspect };

export type LibraryImageParams = {
  trigger: any;                 // Playwright Locator,运行时由 Page 提供
  poi: string;
  description?: string;
  minQuality?: number;
  aspect?: CtripLibraryImageAspect;
  label: string;
};

export async function selectCtripLibraryImage(page: any, params: LibraryImageParams) {
  const { trigger, poi, description, minQuality = 3, aspect = "landscape", label } = params;

  await trigger.hover();
  const libraryImport = trigger.getByText("图库导入", { exact: true });
  await libraryImport.waitFor({ state: "visible", timeout: 3_000 });
  await libraryImport.click();

  const dialog = page.getByRole("dialog").filter({ hasText: "从图库资源导入" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await selectSearchOption(page, dialog, "PoiId", poi, "携程图库景点");

  const descInput = dialog.locator("#description");
  if (description && (await descInput.count())) await descInput.fill(description);

  const queryBtn = dialog.getByRole("button", { name: /查\s*询/ });
  await queryBtn.waitFor({ state: "visible" });
  await queryBtn.click();

  const cards = dialog.locator(".importpic-modal-picitem");
  // 等待至少一张结果出现;8 秒内仍 0 张则抛错
  const deadline = Date.now() + 8_000;
  let count = 0;
  while (Date.now() < deadline) {
    count = await cards.count();
    if (count > 0) break;
    await delay(250);
  }
  if (count === 0) {
    throw new Error(
      `${label}: '${poi}' 在携程图库未找到符合质量要求的图片(质量分 ≥ ${minQuality},${aspect === "landscape" ? "最小 1280×800 横版" : "宽高不限但 ≥1280×800"})`,
    );
  }

  const candidates: Array<{ quality: string; resolution: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const text = (await cards.nth(i).innerText()).replace(/\s+/g, " ");
    candidates.push({
      quality: text.match(/质量分：\s*([\d.]+(?:\s*-\s*[\d.]+)?)/)?.[1] || "",
      resolution: text.match(/分辨率：\s*(\d+\s*\*\s*\d+)/)?.[1] || "",
    });
  }
  const selectedIndex = findBestCtripLibraryImage(candidates, minQuality, aspect);
  if (selectedIndex < 0) {
    throw new Error(
      `${label}: '${poi}' 在携程图库未找到符合质量要求的图片(质量分 ≥ ${minQuality},${aspect === "landscape" ? "最小 1280×800 横版" : "宽高不限但 ≥1280×800"})`,
    );
  }
  await cards.nth(selectedIndex).click();

  const agreement = dialog.getByText(/我已仔细阅读并同意/).locator("xpath=ancestor::label[1]");
  if (await agreement.count()) {
    const checkbox = agreement.locator('input[type="checkbox"]');
    if ((await checkbox.count()) && !(await checkbox.isChecked())) await agreement.click();
  }
  const confirm = dialog.getByRole("button", { name: /同意并导入/ });
  await confirm.waitFor({ state: "visible" });
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });

  return { reused: false };
}
```

注意:`selectSearchOption`、`delay`、`findBestCtripLibraryImage` 已经在 `ctrip.ts` 当前作用域中可用;`page` 用 `any` 是为了避免引入 Playwright 类型依赖(`@ts-nocheck` 已在文件顶部)。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx tsx --test test/library-image.test.ts
```

预期:3 个测试全部通过。

- [ ] **Step 6: 提交**

```bash
git add src/main/automation/ctrip.ts test/library-image.test.ts test/library-image-fixture.html
git commit -m "feat(ctrip): 抽出 selectCtripLibraryImage 通用模块并加集成测试"
```

---

## Task 3: 重构 `selectCtripLibraryCover` 调用通用模块

**Files:**
- Modify: `src/main/automation/ctrip.ts:513-564`(原 `selectCtripLibraryCover`)

**Interfaces:**
- Consumes: `LibraryImageParams` 与 `selectCtripLibraryImage`(Task 2)
- Produces: 保持 `selectCtripLibraryCover(page, cover)` 对外签名不变,内部委托给通用模块

### 步骤

- [ ] **Step 1: 替换 `selectCtripLibraryCover` 实现**

把 `src/main/automation/ctrip.ts:513-564` 整个 `selectCtripLibraryCover` 函数体替换为:

```ts
async function selectCtripLibraryCover(page, cover) {
  if (await hasCoverImage(page)) return { reused: true };

  const section = page.locator(".image-category-container").filter({ hasText: /^\*?封面/ }).first();
  await assertCount(section, 1, "封面图片区块");
  const addCard = section.locator(".add-image-card");
  await assertCount(addCard, 1, "封面添加图片入口");

  await selectCtripLibraryImage(page, {
    trigger: addCard,
    poi: cover.poi,
    description: cover.description,
    minQuality: cover.minQuality ?? 3,
    aspect: "landscape",
    label: "封面",
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await hasCoverImage(page)) return { reused: false };
    await delay(250);
  }
  throw new Error(`已从携程图库导入"${cover.poi}"，但封面未显示在产品图文页。`);
}
```

行为对比:

- 原有"hover → click 图库导入 → 弹窗 → 选 POI → 描述 → 查 → 评分选图 → 协议 → 同意"全部委托给通用模块
- 末尾"封面已落位"轮询 10 秒保留(spec 显式说明该轮询是合理的)
- 错误信息模板与原行为一致

- [ ] **Step 2: 跑完整构建 + 全测试**

```bash
npm run check
npm test
```

预期:`check` 通过(可能有 trailing whitespace 之类被允许);`test` 全部测试通过(既有 + Task 1 + Task 2)。

- [ ] **Step 3: 提交**

```bash
git add src/main/automation/ctrip.ts
git commit -m "refactor(ctrip): selectCtripLibraryCover 改为调用通用模块"
```

---

## Task 4: 验证

**Files:** 无文件改动,只运行命令。

### 步骤

- [ ] **Step 1: 类型检查通过**

```bash
npm run check
```

预期:无 `error TS...`(可能允许非 error 的 lint 警告)。

- [ ] **Step 2: 全部测试通过**

```bash
npm test
```

预期:既有测试 + Task 1、Task 2、Task 3 的所有测试全部通过。

- [ ] **Step 3: 与 baseline 对比测试数**

```bash
npm test 2>&1 | grep -E "^# tests [0-9]+" | tail -1
```

对比 memory 中存储的"重构前测试数"(若有)。若无记录,与 git 上一次 commit 对比:

```bash
git stash
npm test 2>&1 | grep -E "^# tests" | tail -1
git stash pop
```

确认重构后测试数 ≥ 重构前(应等于或更多)。

- [ ] **Step 4: 提交验证记录(可选)**

如果没有改动,跳过提交。如有 README/CLAUDE.md 需要同步 doc 摘要,补充:

```bash
git commit --allow-empty -m "chore: 验证 selectCtripLibraryImage 重构完成"
```

---

## Self-Review Notes

- Spec 覆盖率:
  - "Goals: 抽出 selectCtripLibraryImage" → Task 2 Step 4
  - "改用显式等待替代轮询" → Task 2 Step 4 内的 `waitFor` 节点
  - "0 张匹配图明确报错" → Task 2 Step 4 的双重 `-1` 抛错分支
  - "保持 selectCtripLibraryCover 签名不变" → Task 3 Step 1
  - "为通用模块加测试" → Task 2 Steps 2-5
  - "findBestCtripLibraryImage 增加 aspect" → Task 1

- 类型一致性检查:`CtripLibraryImageAspect` 在 `schema.ts` 导出(Task 1),在 `ctrip.ts` 用 `import type` 引入并 `export type { ... }` 重新导出(Task 2),`LibraryImageParams.aspect` 字段类型为 `CtripLibraryImageAspect`(Task 2)。`selectCtripLibraryCover` 内部硬编码 `aspect: "landscape"`(Task 3)。

- 风险:本计划不要求 e2e 在真实 VBK 上跑通(那需要登录态),只验证通用模块在 fixture 上的语义正确。生产观察是否仍走通封面,留作 spec 之外的运营验证。
