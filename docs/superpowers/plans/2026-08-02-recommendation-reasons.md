# 三条推荐理由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 VBK Desktop 的产品草稿中加入 `presentation.recommendations: Array<{category, text}>`（3 项），由 AI 从 15 个预设分类中选 3 个并各生成一条推荐语；「产品图文」自动化阶段把这 3 组录入 VBK 的「推荐理由」控件；review 页展示这 3 条。

**Architecture:** 数据契约层（zod enum 严格白名单）+ 数据规整层（保证 3 项 + 白名单过滤 + 旧字段兜底）+ AI 层（系统提示词 + JSON schema 同步）+ 自动化层（fillRecommendationReasons 循环 3 次下拉与 3 个文本框）+ 渲染层（review 页新增小节）。所有 schema 改动走 zod strict，旧字段保留向后兼容。

**Tech Stack:** TypeScript + zod + Playwright + React 19 + Node.js `node:test`。

## Global Constraints

- 单一代码库，不引外部依赖。
- 产品 JSON 必须能通过 `parseProduct`（`schema.ts`），因此任何 patch 必须先经过 zod 校验。
- 「推荐理由」分类严格白名单：仅 15 个固定字符串；任何不在白名单的分类必须被丢弃并抛错（不接受默认第一项）。
- 测试入口：`npm test`（运行 `test/**/*.test.ts`）。
- 类型检查：`npm run check`（同时跑 `tsc --noEmit` 与 `tsc -p tsconfig.renderer.json`）。
- 提交信息遵循 Conventional Commits；保持原子（一个 Task 一次提交）。
- 中文 UI 文案；现有 `recommendationCategory` / `recommendation` 字段保留为「主推荐语」（与 `recommendations[0]` 对齐），旧 draft 不破坏。

---

## File Structure

修改 / 新增：

- **Modify** `src/main/automation/schema.ts` — 新增 `RECOMMENDATION_CATEGORIES` 白名单与 `recommendationItemSchema`；`presentationSchema` 加 `recommendations` 数组。
- **Modify** `src/main/product-normalize.ts` — `normalisePresentation` 保证 3 项 + 旧字段兜底 + 白名单过滤。
- **Modify** `src/main/minimax.ts` — `presentationValueSchema` / JSON schema / `presentationJsonSchema` 同步；系统提示词加 3 条推荐理由规则。
- **Modify** `src/main/automation/ctrip.ts` — 新增 `fillRecommendationReasons` 并接入 `fillAndSavePresentation`。
- **Modify** `src/renderer/App.tsx` — review 页「产品卖点」区块新增「推荐理由」小节。
- **Modify** `examples/taiyuan-private-2d1n.json` — 加 `presentation.recommendations` 3 条。
- **Modify** `examples/shanxi-4d3n.json` — 同上。
- **Create** `test/recommendation-reasons.test.ts` — 自动化录入单元测试（依据前置验证结构决定 mock 形态）。

---

## Task 1: 前置验证 VBK 「推荐理由」DOM 结构

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-recommendation-reasons-design.md`（在「实施顺序」下方记录验证结果）

**Interfaces:**
- Consumes: 无（纯探索任务）
- Produces: VBK 产品图文页 DOM 真相，决定 Task 5 用哪种循环形态

- [ ] **Step 1: 启动 Playwright 打开已登录 VBK**

```bash
cd /Users/cisco/Documents/vbk-auto
npm run dev:renderer &
# 等 Vite 启动后用 Playwright 打开产品图文页（任选一个已有 productId 的 URL）
node --input-type=module -e "
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://vbooking.ctrip.com/ivbk/vendor/baseInfoMerge?productId=76476655&tab=presentation');
await page.waitForTimeout(3000);
await page.screenshot({ path: 'artifacts/recommendation-reasons-probe.png', fullPage: true });
console.log(await page.locator('text=推荐理由').count());
console.log(await page.locator('textarea[placeholder*=推荐]').count());
await browser.close();
"
```

- [ ] **Step 2: 报告 DOM 结构**

在终端输出里确认：
- `推荐理由` label 数（期望 3，标识 3 个分组；或 1，标识只有 1 个分类下拉）
- 含「推荐」字样的 textarea 数（期望 3，标识 3 个推荐语输入框）

把 `artifacts/recommendation-reasons-probe.png` 路径与 terminal 输出贴到设计文档「实施顺序」下方，作为决策依据。

- [ ] **Step 3: 把结论写进设计文档并提交**

在 `docs/superpowers/specs/2026-08-02-recommendation-reasons-design.md` 「实施顺序」下方追加：

```markdown
## 验证结果（YYYY-MM-DD HH:MM）

- 推荐理由 label 数：N
- 推荐语 textarea 数：N
- 结论：Task 5 采用「循环 3 次不同 combobox」或「1 个 combobox + 3 个 textarea」方案
- 截图：`artifacts/recommendation-reasons-probe.png`
```

```bash
git add docs/superpowers/specs/2026-08-02-recommendation-reasons-design.md artifacts/recommendation-reasons-probe.png
git commit -m "docs: 验证 VBK 推荐理由 DOM 结构"
```

---

## Task 2: schema.ts 增加分类白名单与数组 schema

**Files:**
- Modify: `src/main/automation/schema.ts:22-34`（在 `presentationSchema` 之前加白名单与 item schema）

**Interfaces:**
- Consumes: 无
- Produces:
  - 导出常量 `RECOMMENDATION_CATEGORIES: readonly string[]`（15 项）
  - 导出 schema `recommendationItemSchema`（`{category: enum, text: min(1)}`）
  - `presentationSchema` 增加 `recommendations: z.array(recommendationItemSchema).length(3).default([])`

- [ ] **Step 1: 写失败测试（test/schema.test.ts）**

在文件末尾追加：

```ts
import { RECOMMENDATION_CATEGORIES } from "../src/main/automation/schema.js";

test("presentation.recommendations 必须是 15 个白名单分类之一", () => {
  assert.equal(RECOMMENDATION_CATEGORIES.length, 15);
  assert.ok(RECOMMENDATION_CATEGORIES.includes("优选行程"));
  assert.ok(RECOMMENDATION_CATEGORIES.includes("缤纷体验"));
});

test("parseProduct 接受 3 项 recommendations", () => {
  const raw = JSON.parse(await fs.readFile("examples/taiyuan-private-2d1n.json", "utf8"));
  raw.presentation.recommendations = [
    { category: "优选行程", text: "推荐 1" },
    { category: "精选酒店", text: "推荐 2" },
    { category: "缤纷景点", text: "推荐 3" },
  ];
  const product = parseProduct(raw);
  assert.equal(product.presentation.recommendations.length, 3);
  assert.equal(product.presentation.recommendations[0].category, "优选行程");
});

test("parseProduct 拒绝非白名单分类", () => {
  const raw = JSON.parse(await fs.readFile("examples/taiyuan-private-2d1n.json", "utf8"));
  raw.presentation.recommendations = [
    { category: "超值套餐", text: "非法分类" },
    { category: "精选酒店", text: "合法" },
    { category: "缤纷景点", text: "合法" },
  ];
  assert.throws(() => parseProduct(raw), /非白名单|Invalid enum value/);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test -- test/schema.test.ts
```

Expected: 3 failures（`RECOMMENDATION_CATEGORIES is not exported` / parseProduct 缺字段 / 缺 schema 报错）。

- [ ] **Step 3: 实现 schema**

修改 `src/main/automation/schema.ts`，在 `presentationSchema` 定义之前插入：

```ts
export const RECOMMENDATION_CATEGORIES = [
  "优选行程", "服务保障", "贴心赠送", "精选酒店", "缤纷景点",
  "特色美食", "度假首选", "超值赠送", "五星精选", "限时秒杀",
  "尊享入住", "大牌驾到", "优质交通", "优良资质", "缤纷体验",
] as const;

export const recommendationItemSchema = z.object({
  category: z.enum(RECOMMENDATION_CATEGORIES),
  text: z.string().min(1),
});
```

把 `presentationSchema` 改为：

```ts
const presentationSchema = z.object({
  recommendationCategory: z.string().min(1).default("优选行程"),
  recommendation: z.string().min(1),
  recommendations: z.array(recommendationItemSchema).length(3).default([]),
  features: z.string().min(1),
  cover: z
    .object({
      source: z.literal("ctripLibrary").default("ctripLibrary"),
      poi: z.string().min(1),
      description: z.string().min(1),
      minQuality: z.number().min(0).max(5).default(3),
    })
    .optional(),
});
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test -- test/schema.test.ts
```

Expected: 全部通过。

- [ ] **Step 5: 类型检查**

```bash
cd /Users/cisco/Documents/vbk-auto
npm run check
```

Expected: 0 errors。

- [ ] **Step 6: 提交**

```bash
git add src/main/automation/schema.ts test/schema.test.ts
git commit -m "feat(schema): presentation 增加 recommendations 3 项与 15 类白名单"
```

---

## Task 3: product-normalize 保证 3 项 + 旧字段兜底 + 白名单过滤

**Files:**
- Modify: `src/main/product-normalize.ts:25-39`（`normalisePresentation`）

**Interfaces:**
- Consumes: `presentationSchema`（Task 2 产出）
- Produces: `normalisePresentation(record)` 返回 `{ recommendationCategory, recommendation, recommendations: [3 items], features, cover? }`

- [ ] **Step 1: 写失败测试（test/product-normalize.test.ts）**

新建 `test/product-normalize.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { normalisePresentation } from "../src/main/product-normalize.js";

test("AI 给出 3 项 recommendations 时原样保留", () => {
  const result = normalisePresentation({
    recommendationCategory: "优选行程",
    recommendation: "主推荐语",
    recommendations: [
      { category: "优选行程", text: "推荐 1" },
      { category: "精选酒店", text: "推荐 2" },
      { category: "缤纷景点", text: "推荐 3" },
    ],
    features: "特点",
  });
  assert.equal(result?.recommendations.length, 3);
  assert.equal(result?.recommendations[0].category, "优选行程");
});

test("AI 未给出 recommendations 时从旧字段兜底到 3 项", () => {
  const result = normalisePresentation({
    recommendationCategory: "精选酒店",
    recommendation: "主推荐语",
    features: "特点",
  });
  assert.equal(result?.recommendations.length, 3);
  // 第 1 项应是旧字段的复制
  assert.equal(result?.recommendations[0].category, "精选酒店");
  assert.equal(result?.recommendations[0].text, "主推荐语");
});

test("非白名单分类被丢弃并报错", () => {
  assert.throws(() => normalisePresentation({
    recommendationCategory: "优选行程",
    recommendation: "主推荐语",
    recommendations: [
      { category: "超值套餐", text: "非法" },
      { category: "精选酒店", text: "合法" },
      { category: "缤纷景点", text: "合法" },
    ],
    features: "特点",
  }), /推荐理由分类.*不在白名单/);
});

test("重复 category 被去重并补足", () => {
  const result = normalisePresentation({
    recommendationCategory: "优选行程",
    recommendation: "主推荐语",
    recommendations: [
      { category: "优选行程", text: "A" },
      { category: "优选行程", text: "B" }, // 重复
      { category: "缤纷景点", text: "C" },
    ],
    features: "特点",
  });
  const cats = result?.recommendations.map((r) => r.category);
  assert.equal(new Set(cats).size, 3); // 3 个不同分类
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test -- test/product-normalize.test.ts
```

Expected: 全失败（`recommendations` 缺字段、兜底未实现、白名单未过滤、重复未去重）。

- [ ] **Step 3: 实现 normalisePresentation**

修改 `src/main/product-normalize.ts`，把 `normalisePresentation` 改为：

```ts
import { HOTEL_TIER_VALUES, LEGACY_FIVE_DIAMOND_HOTEL_TIER } from "../shared/hotel-tiers.js";
import { RECOMMENDATION_CATEGORIES } from "./automation/schema.js";

export function normalisePresentation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const highlights = Array.isArray(record.highlights) ? record.highlights.map(textValue).filter(Boolean) : [];
  const recommendationCategory = textValue(record.recommendationCategory) || "优选行程";
  const recommendation = textValue(record.recommendation) || textValue(record.description) || textValue(record.subtitle) || textValue(record.productName);
  const features = textValue(record.features) || highlights.join("\n") || textValue(record.highlightsMore);
  if (!recommendation || !features) return undefined;

  // 推荐理由：先按白名单过滤 AI 给出的数组；旧字段（无数组）时用主推荐语兜底；重复 category 去重。
  const rawList = Array.isArray(record.recommendations) ? record.recommendations : [];
  const filtered: { category: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const category = textValue(r.category);
    const text = textValue(r.text);
    if (!category || !text) continue;
    if (!RECOMMENDATION_CATEGORIES.includes(category)) {
      throw new Error(`推荐理由分类「${category}」不在白名单，无法继续。`);
    }
    if (seen.has(category)) continue;
    seen.add(category);
    filtered.push({ category, text });
  }
  if (filtered.length === 0) {
    // 兜底：用旧字段复制 1 条，再用主推荐语复制补到 3 条
    const baseText = recommendation;
    filtered.push({ category: recommendationCategory, text: baseText });
    filtered.push({ category: "缤纷景点", text: baseText });
    filtered.push({ category: "特色美食", text: baseText });
  }
  // 不足 3 项：用主推荐语 + 后续白名单分类补足（但 text 必须非空且不和已有重复）
  if (filtered.length < 3) {
    let i = 0;
    while (filtered.length < 3 && i < RECOMMENDATION_CATEGORIES.length) {
      const cat = RECOMMENDATION_CATEGORIES[i];
      if (!seen.has(cat)) {
        filtered.push({ category: cat, text: recommendation });
        seen.add(cat);
      }
      i += 1;
    }
  }
  if (filtered.length < 3) {
    throw new Error("推荐理由无法补足到 3 项，请检查产品草稿。");
  }
  // 截取前 3 项
  const recommendations = filtered.slice(0, 3);

  const cover = record.cover && typeof record.cover === "object" && !Array.isArray(record.cover) ? record.cover : undefined;
  return {
    recommendationCategory,
    recommendation,
    recommendations,
    features,
    ...(cover ? { cover } : {}),
  };
}
```

（其余 `normaliseActivities` / `normaliseMeals` / `normaliseItinerary` / `normaliseProductDraft` 保持不变。）

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test -- test/product-normalize.test.ts
```

Expected: 全部通过。

- [ ] **Step 5: 类型检查**

```bash
cd /Users/cisco/Documents/vbk-auto
npm run check
```

Expected: 0 errors。

- [ ] **Step 6: 提交**

```bash
git add src/main/product-normalize.ts test/product-normalize.test.ts
git commit -m "feat(normalize): recommendations 保证 3 项 + 白名单过滤 + 旧字段兜底"
```

---

## Task 4: minimax.ts AI 生成同步

**Files:**
- Modify: `src/main/minimax.ts`（`presentationValueSchema`、`responseJsonSchema`、`presentationJsonSchema`、`systemPrompt`）

**Interfaces:**
- Consumes: `recommendationItemSchema`（Task 2 导出）
- Produces:
  - `presentationValueSchema.recommendations` 字段声明
  - `responseJsonSchema.properties.presentation` 字段声明（同步）
  - `presentationJsonSchema.properties.recommendations` 字段声明（generateField 用）
  - `systemPrompt` 增加 3 条推荐理由规则

- [ ] **Step 1: 写失败测试（test/minimax.test.ts）**

在 `test/minimax.test.ts` 末尾追加：

```ts
test("reply 解析包含 recommendations 的 presentation patch", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: { name: "submit_product_update", arguments: JSON.stringify({
          reply: "ok",
          patch: [{ op: "add", path: "/presentation", value: {
            recommendationCategory: "优选行程",
            recommendation: "主推荐语",
            recommendations: [
              { category: "优选行程", text: "推荐 1" },
              { category: "精选酒店", text: "推荐 2" },
              { category: "缤纷景点", text: "推荐 3" },
            ],
            features: "特点",
          }}],
          questions: [],
          researchTasks: [],
        }) }
      }] } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  const result = await service.reply({ message: "生成第一版", product: { itinerary: [] }, history: [] });
  assert.equal(result.patch?.[0]?.op, "add");
  const value = (result.patch?.[0] as { value?: { recommendations?: unknown[] } }).value;
  assert.equal(value?.recommendations?.length, 3);
});

test("reply 拒绝含非白名单分类的 recommendations", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: { name: "submit_product_update", arguments: JSON.stringify({
          reply: "ok",
          patch: [{ op: "add", path: "/presentation", value: {
            recommendationCategory: "优选行程",
            recommendation: "主推荐语",
            recommendations: [
              { category: "超值套餐", text: "非法" },
              { category: "精选酒店", text: "合法" },
              { category: "缤纷景点", text: "合法" },
            ],
            features: "特点",
          }}],
          questions: [],
          researchTasks: [],
        }) }
      }] } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
  // 非白名单分类应当在 normalisePresentation 阶段抛错
  await assert.rejects(
    () => service.reply({ message: "生成第一版", product: { itinerary: [] }, history: [] }),
    /白名单/,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test -- test/minimax.test.ts
```

Expected: 2 failures（recommendations 字段缺失导致 parseProduct 拒绝 / 非白名单分类未过滤）。

- [ ] **Step 3: 修改 minimax.ts**

在文件顶部 import 区域加：

```ts
import { recommendationItemSchema } from "./automation/schema.js";
```

修改 `presentationValueSchema`：

```ts
const presentationValueSchema = z.object({
  recommendationCategory: nonEmptyText,
  recommendation: nonEmptyText,
  recommendations: z.array(recommendationItemSchema).length(3),
  features: nonEmptyText,
});
```

`responseJsonSchema` 是 JSON-Schema 形式（在 OpenAI 工具调用里），同步声明：

```ts
// 在 responseJsonSchema.properties.presentation 块中追加
recommendations: {
  type: "array", minItems: 3, maxItems: 3,
  items: {
    type: "object", additionalProperties: false,
    required: ["category", "text"],
    properties: {
      category: { type: "string", enum: [...RECOMMENDATION_CATEGORIES] },
      text: { type: "string", minLength: 1 },
    },
  },
},
```

并在 `presentationJsonSchema`（`generateField` 调用里）同步追加同样字段。

修改 `systemPrompt`，在末尾的 `${outputGuide}` 之前插入：

```ts
const recommendationReasonsGuide = `推荐理由必须给出 3 项；每项 category 必须从下列 15 个分类中精确选择（${RECOMMENDATION_CATEGORIES.join("、")}），text 是面向客人的简短推荐语；3 项 category 不可重复，text 必须结合目的地、产品形态和行程亮点，避免空话。`;
```

并把它拼接到 systemPrompt 字符串中（`${recommendationReasonsGuide}\n\n${writablePatchGuide}\n\n${outputGuide}`）。

最后在顶部 import 区域导出 RECOMMENDATION_CATEGORIES（已在 schema.ts 导出）。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test -- test/minimax.test.ts
```

Expected: 全部通过。

- [ ] **Step 5: 类型检查**

```bash
cd /Users/cisco/Documents/vbk-auto
npm run check
```

Expected: 0 errors。

- [ ] **Step 6: 提交**

```bash
git add src/main/minimax.ts test/minimax.test.ts
git commit -m "feat(minimax): presentation 同步 recommendations 3 项与系统提示词"
```

---

## Task 5: 实施 fillRecommendationReasons 并接入 fillAndSavePresentation

**Files:**
- Modify: `src/main/automation/ctrip.ts`（新增 `fillRecommendationReasons`，并在 `fillAndSavePresentation` 调用）
- Create: `test/recommendation-reasons.test.ts`（mock VBK DOM 验证循环逻辑）

**Interfaces:**
- Consumes: `RECOMMENDATION_CATEGORIES`、`recommendationItemSchema`（Task 2 导出）；`fillAndSavePresentation` 流程（已有）
- Produces: `fillRecommendationReasons(page, recommendations: Array<{category, text}>)` 函数

⚠️ **依赖 Task 1 的验证结论**：根据 VBK DOM 是「3 个独立 combobox」还是「1 个 combobox + 3 个 textarea」，选择对应实现。下面的代码假设「3 个 combobox + 3 个 textarea」（最常见形态）。若 Task 1 验证结果不同，把 Step 3 的循环替换为单 combobox 形态。

- [ ] **Step 1: 写失败测试（test/recommendation-reasons.test.ts）**

新建 `test/recommendation-reasons.test.ts`，**仅做纯函数单元测试**，不调用 Playwright：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { RECOMMENDATION_CATEGORIES } from "../src/main/automation/schema.js";

// 占位：以下函数从 ctrip.ts 导出纯函数 buildRecommendationReasonsPlan 用于测试。
// 该函数接受 recommendations: Array<{category, text}>，返回每步 plan（便于断言）。
import { buildRecommendationReasonsPlan } from "../src/main/automation/ctrip.js";

test("3 项分类去重后顺序保留", () => {
  const plan = buildRecommendationReasonsPlan([
    { category: "精选酒店", text: "B" },
    { category: "优选行程", text: "A" },
    { category: "缤纷景点", text: "C" },
  ]);
  assert.equal(plan.length, 3);
  assert.equal(plan[0]?.category, "精选酒店");
});

test("少于 3 项抛错", () => {
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "优选行程", text: "A" },
  ]), /3 项/);
});

test("非白名单分类抛错", () => {
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "超值套餐", text: "非法" },
    { category: "精选酒店", text: "B" },
    { category: "缤纷景点", text: "C" },
  ]), /白名单/);
});

test("重复分类抛错", () => {
  assert.throws(() => buildRecommendationReasonsPlan([
    { category: "优选行程", text: "A" },
    { category: "优选行程", text: "B" },
    { category: "缤纷景点", text: "C" },
  ]), /重复/);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test -- test/recommendation-reasons.test.ts
```

Expected: 全部失败（`buildRecommendationReasonsPlan is not exported`）。

- [ ] **Step 3: 实现 buildRecommendationReasonsPlan + fillRecommendationReasons**

在 `src/main/automation/ctrip.ts` 顶部 import 区域加：

```ts
import { RECOMMENDATION_CATEGORIES } from "./schema.js";
```

并在文件顶部（`delay` 定义之前）新增纯函数（可被测试引用）：

```ts
export interface RecommendationPlanStep {
  index: number;
  category: string;
  text: string;
}

export function buildRecommendationReasonsPlan(
  recommendations: ReadonlyArray<{ category: string; text: string }>,
): RecommendationPlanStep[] {
  if (!Array.isArray(recommendations) || recommendations.length !== 3) {
    throw new Error("推荐理由必须为 3 项，请先在产品草稿中维护。");
  }
  const seen = new Set<string>();
  const plan: RecommendationPlanStep[] = [];
  for (let i = 0; i < 3; i += 1) {
    const item = recommendations[i]!;
    const { category, text } = item;
    if (!RECOMMENDATION_CATEGORIES.includes(category)) {
      throw new Error(`推荐理由分类「${category}」不在白名单。`);
    }
    if (!text || !text.trim()) {
      throw new Error(`推荐理由第 ${i + 1} 项文本为空。`);
    }
    if (seen.has(category)) {
      throw new Error(`推荐理由分类「${category}」重复。`);
    }
    seen.add(category);
    plan.push({ index: i, category, text });
  }
  return plan;
}
```

然后实现 `fillRecommendationReasons`（紧跟 `selectCtripLibraryCover` 之后的位置）：

```ts
async function fillRecommendationReasons(page: Page, recommendations: Array<{ category: string; text: string }>) {
  const plan = buildRecommendationReasonsPlan(recommendations);

  // 锚点 label「推荐理由」定位最近 form 区域；3 个 combobox + 3 个 textarea。
  const scope = page.locator('xpath=//label[normalize-space(text())="推荐理由"]/ancestor::*[contains(@class,"ant-form-item")][1]')
    .or(page.locator('div').filter({ has: page.getByText("推荐理由", { exact: true }) }).first());
  // 若 label 锚点失败，回退到全局：取页内全部 ant-form-item，校验 3 个「推荐理由」组
  // ——为简化实现，这里采用「按 label 精确文本定位 3 个 form-item」策略
  const groups = page.getByText("推荐理由", { exact: true });
  const groupCount = await groups.count();
  if (groupCount < 3) {
    // 退化：单 combobox + 3 textarea 形态
    const combobox = page.locator(".ant-select-selection").filter({ hasText: "" }).first();
    // 只选第 1 项分类
    await combobox.click();
    await delay(400);
    const options = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option");
    const texts = (await options.allTextContents()).map((t) => t.trim());
    const idx = texts.indexOf(plan[0]!.category);
    if (idx < 0) throw new Error(`推荐理由下拉未找到「${plan[0]!.category}」；可选：${texts.join("、")}`);
    await options.nth(idx).click();
    // 填 3 个 textarea
    const textareas = page.locator('textarea[placeholder*="推荐"]');
    const taCount = await textareas.count();
    if (taCount < 3) throw new Error(`推荐语 textarea 数量不足：期望 3，实际 ${taCount}`);
    for (let i = 0; i < 3; i += 1) await textareas.nth(i).fill(plan[i]!.text);
    return;
  }

  // 主流形态：3 个独立 form-item，每个含 1 个 combobox + 1 个 textarea
  for (let i = 0; i < 3; i += 1) {
    const label = groups.nth(i);
    const formItem = label.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ')][1]");
    const combobox = formItem.getByRole("combobox");
    await assertCount(combobox, 1, `第 ${i + 1} 组推荐理由 combobox`);
    await combobox.click();
    await delay(400);
    const options = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option");
    await options.first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    const texts = (await options.allTextContents()).map((t) => t.trim());
    const idx = texts.indexOf(plan[i]!.category);
    if (idx < 0) throw new Error(`第 ${i + 1} 组推荐理由未找到「${plan[i]!.category}」；可选：${texts.join("、")}`);
    await options.nth(idx).click();
    await delay(300);

    const textarea = formItem.locator('textarea[placeholder*="推荐"]');
    await assertCount(textarea, 1, `第 ${i + 1} 组推荐语 textarea`);
    await textarea.fill(plan[i]!.text);
  }
}
```

最后修改 `fillAndSavePresentation`，在 `selectCtripLibraryCover(page, presentation.cover)` 之后、`fillFirstVisible(推荐语输入框)` 之前插入：

```ts
if (presentation.recommendations?.length === 3) {
  await fillRecommendationReasons(page, presentation.recommendations);
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test -- test/recommendation-reasons.test.ts
```

Expected: 全部通过。

- [ ] **Step 5: 类型检查**

```bash
cd /Users/cisco/Documents/vbk-auto
npm run check
```

Expected: 0 errors。

- [ ] **Step 6: 提交**

```bash
git add src/main/automation/ctrip.ts test/recommendation-reasons.test.ts
git commit -m "feat(automation): fillRecommendationReasons 录入 3 组推荐理由"
```

---

## Task 6: review 页 UI 新增「推荐理由」小节

**Files:**
- Modify: `src/renderer/App.tsx:861-870`（`review-copy` 区块）

**Interfaces:**
- Consumes: `presentation.recommendations: Array<{category, text}>`（Task 2）
- Produces: 第三个 `review-copy-block`，展示 3 条 `category：text`

- [ ] **Step 1: 修改 App.tsx**

在 `<div className="review-copy">` 内（第 866-869 行的「产品特点」block 之后）追加：

```tsx
<div className="review-copy-block">
  <span className="review-copy-kicker">推荐理由（3 条）</span>
  {presentation.recommendations.length === 3 ? (
    <ul className="review-copy-reasons">
      {presentation.recommendations.map((r, index) => (
        <li key={index}>
          <strong>{r.category}</strong>
          <span>{r.text}</span>
        </li>
      ))}
    </ul>
  ) : (
    <p className="section-empty">正在等待 AI 生成推荐理由…</p>
  )}
</div>
```

- [ ] **Step 2: 类型检查**

```bash
cd /Users/cisco/Documents/vbk-auto
npm run check
```

Expected: 0 errors。

- [ ] **Step 3: 视觉冒烟（可选）**

```bash
cd /Users/cisco/Documents/vbk-auto
npm run dev
# 在浏览器打开 http://127.0.0.1:5173，加载一个含 recommendations 的产品，截图确认新小节
```

- [ ] **Step 4: 提交**

```bash
git add src/renderer/App.tsx
git commit -m "feat(renderer): review 页新增推荐理由小节"
```

---

## Task 7: 示例 JSON 添加 recommendations 3 条

**Files:**
- Modify: `examples/taiyuan-private-2d1n.json`（`presentation` 块）
- Modify: `examples/shanxi-4d3n.json`（`presentation` 块）

**Interfaces:**
- Consumes: 现有 `presentation.recommendation` / `recommendationCategory` 文本
- Produces: `presentation.recommendations: [3 items]`

- [ ] **Step 1: 太原样例**

在 `examples/taiyuan-private-2d1n.json` 的 `presentation` 下加：

```json
"recommendations": [
  { "category": "优选行程", "text": "2天串联晋祠古建与三晋文明，节奏舒适不赶路。" },
  { "category": "精选酒店", "text": "精选当地 3 钻酒店，含自助早餐。" },
  { "category": "缤纷景点", "text": "覆盖晋祠、山西博物院、晋商博物院等核心景点。" }
]
```

- [ ] **Step 2: 山西样例**

在 `examples/shanxi-4d3n.json` 的 `presentation` 下加：

```json
"recommendations": [
  { "category": "优选行程", "text": "4 天覆盖云冈石窟、悬空寺、平遥古城与壶口瀑布。" },
  { "category": "缤纷景点", "text": "串联山西四大世界遗产与黄河景观。" },
  { "category": "特色美食", "text": "沿途安排大同刀削面、平遥牛肉等山西特色餐。" }
]
```

- [ ] **Step 3: 跑解析测试确认样例仍能 parse**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test -- test/schema.test.ts
```

Expected: 全部通过（含 Task 2 增加的「presentation.recommendations 必须是 15 个白名单分类之一」）。

- [ ] **Step 4: 提交**

```bash
git add examples/taiyuan-private-2d1n.json examples/shanxi-4d3n.json
git commit -m "docs(examples): 两个示例产品加 recommendations 3 条"
```

---

## Task 8: 收尾全量测试与类型检查

**Files:** 无新增

- [ ] **Step 1: 跑全部测试**

```bash
cd /Users/cisco/Documents/vbk-auto
npm test
```

Expected: 全部通过（包括 schema / product-normalize / minimax / recommendation-reasons / readiness-gate / product-patch 等）。

- [ ] **Step 2: 全量类型检查**

```bash
cd /Users/cisco/Documents/vbk-auto
npm run check
```

Expected: 0 errors。

- [ ] **Step 3: 提交（若有遗漏修复）**

```bash
git status
# 若有改动：
git add -A
git commit -m "chore: 测试与类型检查通过"
```

---

## 自审检查（已完成）

- **Spec 覆盖**：5 个设计节（数据契约 / 数据规整 / AI / 自动化 / UI / 示例 JSON）均有对应 Task（Task 2 / 3 / 4 / 5 / 6 / 7）。前置验证作为 Task 1；测试覆盖为 Task 8 + 各 Task 自带 step。
- **占位符扫描**：无 TBD / TODO；Task 5 的「依赖 Task 1」已通过 `⚠️ 依赖 Task 1` 标注并给出 fallback 实现。
- **类型一致性**：
  - `recommendationItemSchema` 在 schema.ts 导出，minimax.ts 与 ctrip.ts 都引用。
  - `buildRecommendationReasonsPlan` 在 ctrip.ts 导出，test 文件 import。
  - `presentation.recommendations` 在所有 layer 都用相同 `Array<{category, text}>` 形态。