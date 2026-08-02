# 三条推荐理由（产品图文）设计

> 状态：草稿（待用户审阅）
> 日期：2026-08-02

## 背景

VBK 后台「产品图文」页有「推荐理由」下拉菜单，包含 15 个预设分类：优选行程、服务保障、贴心赠送、精选酒店、缤纷景点、特色美食、度假首选、超值赠送、五星精选、限时秒杀、尊享入住、大牌驾到、优质交通、优良资质、缤纷体验。

当前 `presentation` 数据结构只有单个推荐理由（`recommendationCategory` + `recommendation`），运营希望 AI 从 15 个分类中选出 3 个最契合该产品的分类，并为每个分类各生成一条推荐语；在「产品图文」自动化录入阶段把这 3 组 `{分类, 推荐语}` 写入 VBK 对应控件。

## 目标

1. AI 在生成产品文案（presentation）时同时给出 3 组 `{分类, 推荐语}`，分类严格来自 15 个白名单。
2. 「产品图文」自动化阶段把这 3 组录入 VBK 的 3 个「推荐理由」下拉 + 3 个推荐语输入框。
3. review 页「产品卖点」区块新增「推荐理由」小节展示这 3 条。
4. 旧字段 `recommendationCategory` / `recommendation` 保留作为「主推荐语」（与新数组第 1 条对齐），旧 draft 不破坏。

## 设计

### 1. 数据契约（`src/main/automation/schema.ts`）

新增 15 个分类白名单 + 数组 schema：

```ts
export const RECOMMENDATION_CATEGORIES = [
  "优选行程", "服务保障", "贴心赠送", "精选酒店", "缤纷景点",
  "特色美食", "度假首选", "超值赠送", "五星精选", "限时秒杀",
  "尊享入住", "大牌驾到", "优质交通", "优良资质", "缤纷体验",
] as const;

const recommendationItemSchema = z.object({
  category: z.enum(RECOMMENDATION_CATEGORIES),
  text: z.string().min(1),
});

const presentationSchema = z.object({
  recommendationCategory: z.string().min(1).default("优选行程"),
  recommendation: z.string().min(1),
  recommendations: z.array(recommendationItemSchema).length(3).default([]),
  features: z.string().min(1),
  cover: z.optional(...),
});
```

`recommendationCategory` / `recommendation` 保留为「主推荐语」，与 `recommendations[0]` 一致即可；保留便于历史 draft 不被破坏。

### 2. 数据规整（`src/main/product-normalize.ts`）

`normalisePresentation` 在解析时保证 `recommendations.length === 3`：

- AI 返回包含 `recommendations` 时按白名单过滤（去除非白名单分类）；
- AI 未给出 `recommendations`（旧数据）时用 `{recommendationCategory, recommendation}` 复制出 1 条，再补 2 条占位（占位项 `category="优选行程"`，`text=recommendation`，但 text 必须不重复；不足 3 条且无其它文本可用时抛错）；
- 重复的 `category` 视为非法，保留先出现的项并继续补足。

### 3. AI 生成（`src/main/minimax.ts`）

1. `presentationValueSchema` 增加 `recommendations: z.array(recommendationItemSchema).length(3)`。
2. `responseJsonSchema` / `submit_product_update` 工具参数：在 `presentation.properties` 里增加该字段声明。
3. `presentationJsonSchema`（`generateField` 调用）同步增加 `recommendations`。
4. 系统提示词（`systemPrompt`）末尾增加：
   > 「推荐理由必须给出 3 项；每项 `category` 必须从下列 15 个分类中精确选择（优选行程/服务保障/贴心赠送/精选酒店/缤纷景点/特色美食/度假首选/超值赠送/五星精选/限时秒杀/尊享入住/大牌驾到/优质交通/优良资质/缤纷体验），`text` 是面向客人的简短推荐语；3 项分类不可重复，`text` 必须结合目的地、产品形态和行程亮点，避免空话。」

`recommendationCategory` / `recommendation`（主推荐语）允许与 `recommendations[0]` 对齐；缺省时由 `normalisePresentation` 兜底。

### 4. 自动化录入（`src/main/automation/ctrip.ts`）

新增函数 `fillRecommendationReasons(page, recommendations)`，并在 `fillAndSavePresentation` 中调用（位置：`selectCtripLibraryCover` 之后、`fillFirstVisible(推荐语输入框)` 之前）。

```ts
async function fillRecommendationReasons(page, recommendations) {
  if (!Array.isArray(recommendations) || recommendations.length !== 3) {
    throw new Error("推荐理由必须为 3 项，请先在产品草稿中维护。");
  }
  // 锚点 label「推荐理由」取最近 form-item；校验 3 个 combobox + 3 个 textarea
  // 的整体结构（assertCount === 3 兜底）。
  // 循环：
  //   comboboxes.nth(i).click → 选 RECOMMENDATION_CATEGORIES[i]
  //   textareas.nth(i).fill(recommendations[i].text)
  // 任意一项分类在 VBK 下拉里找不到（含 disabled）一律抛错，不允许默认第一项。
}
```

**实施前的前置任务**：用 Playwright 打开产品图文页，确认 VBK 真实 DOM 是否为「3 个『推荐理由』下拉 + 3 个独立推荐语 textarea」结构；若实际只有 1 个下拉 + 3 个文本框，把 `comboboxes.nth(i)` 改成同一 combobox 循环 3 次（仅在第 1 次 click 后选 3 个分类中的第 1 个，因为分类不能重复 → 改为：3 个文本框各填一条，`combobox` 选 `recommendations[0].category`）。这一步必须在写代码前完成。

### 5. 渲染层（`src/renderer/App.tsx`）

「产品卖点」区块（`.review-copy`）新增第三个 block：

```tsx
<div className="review-copy-block">
  <span className="review-copy-kicker">推荐理由（3 条）</span>
  <ul className="review-copy-reasons">
    {presentation.recommendations.map((r, i) => (
      <li key={i}><strong>{r.category}</strong>：{r.text}</li>
    ))}
  </ul>
</div>
```

样式沿用 `.review-copy-block`（kicker + 内容），空态显示「正在等待 AI 生成推荐理由…」。

### 6. 示例 JSON（`examples/`）

更新 `taiyuan-private-2d1n.json` 与 `shanxi-4d3n.json`，在 `presentation` 下加 `recommendations: [...]` 3 条。

## 测试

- `test/schema.test.ts`：分类白名单校验、3 项长度校验、缺项抛错、重复 category 抛错。
- `test/product-normalize.test.ts`：旧字段无 `recommendations` 时补足 3 条、白名单过滤、重复 category 保留先出现的项。
- `test/minimax.test.ts`：AI 返回 3 项时正确解析；分类不在白名单被丢弃；返回不足 3 项抛错。
- `test/automation.test.ts`（若已有）/ 新增 `test/recommendation-reasons.test.ts`：`fillRecommendationReasons` 单元测试模拟 VBK 控件结构。

## 前置验证（blocker）

在写任何自动化代码前，必须先用 Playwright 打开已登录 VBK 的产品图文页，核对真实 DOM 结构：
- 推荐理由下拉是 3 个独立 combobox（每个对应一组 `{分类, 推荐语}`），还是 1 个 combobox + 3 个 textarea？
- 3 个 textarea 的 placeholder 是否都包含「推荐」字样，便于和现有单个「推荐语」输入框区分？

只有核对完成后才能决定 `fillRecommendationReasons` 是循环 3 次不同 combobox 还是复用同一 combobox。这一步是 blocker，未完成前不允许进入 §4 的实现。

## 实施顺序

1. 完成「前置验证」并把核对结果（截图 + DOM 片段）记录在本节下方。
2. 更新 `schema.ts`、`product-normalize.ts`。
3. 更新 `minimax.ts` 系统提示词与 JSON schema。
4. 实施 `fillRecommendationReasons` 并接入 `fillAndSavePresentation`。
5. 更新 `App.tsx` review 页。
6. 更新示例 JSON。
7. 跑全部测试。