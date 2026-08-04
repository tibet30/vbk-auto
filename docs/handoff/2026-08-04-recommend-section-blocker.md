# VBK 推荐理由区域 Blocker — 已修复

> 立项：2026-08-04 / 修复完成：2026-08-04
> 项目：`/Users/cisco/Documents/vbk-auto`
> 分支改动：
> - `src/main/automation/ctrip.ts` — 新增 `appendRecommendationRow` + 在 `fillRecommendationReasons` 头部扩行
> - `test/recommendation-reasons.test.ts` — fixture 渲染真实 `+` 按钮；新增 / 改写若干用例

---

## 1. 用户诉求（已完成）

- 项目：**大同2天1晚私家团**（VBK `productId = 76522394`）
- 阻塞文案：「自动录入已停止 — 请在 VBK 手动确认后再次保存草稿。」
- 修复路径：在 `presentation` 阶段从「1 行扩到 3 行」再开始填写，VBK 草稿可保存。

---

## 2. 根因

`fillAndSavePresentation` 假设 `#pm_recommend` 已经渲染 3 行，但真实 VBK 页面**默认只渲染 1 行**。原代码没有「点 + 扩行」逻辑，导致断言层报：
- `推荐理由区域数量异常：期望 1，实际 2`（在 synthetic 测试触发；真实 VBK 中是 `rows.count() < 3` 导致 iteration 跑 1 次后 hang）
- `第 1 组填写后未生成第 2 组`（在真实 VBK 中是等待 `rows.nth(1)` 可见直到超时）

---

## 3. 真实 VBK DOM 行为（已二次验证）

### 3.1 初始状态（1 行）

```
#pm_recommend > div.ant-form-item (1 row)
  ├─ combobox #pmRcmdItems_0_pmRcmdCategoryId  (selection-item title="空")
  ├─ textarea  #pmRcmdItems_0_rcmdDesc
  └─ span.anticon[style*="rgb(22, 88, 220)"]  ← + 按钮
```

### 3.2 点 + 一次后

```
#pm_recommend > div.ant-form-item (2 rows)
  - row 0：仅 1 个图标（下拉箭头，无蓝）
  - row 1：3 个图标（dropdown arrow + − + +）
```

### 3.3 关键样式（重要！）

VBK 渲染时**把源码里的 `#1658DC` 序列化为 `rgb(22, 88, 220)`**（带空格、有分号），但部分 React 重渲染会保留 `#1658DC` 字面。**两种形式都会出现**，所以选择器必须兼容。

实测偶发两种形式：
- `font-size: 19px; color: rgb(22, 88, 220); margin-top: 1px;`
- `font-size:19px;color:#1658DC;margin-top:1px`

### 3.4 Playwright 坑

- `page.locator(...).click()` 会被 `span[title="空"]` 拦截 → 必须 `page.evaluate(() => el.click())`。
- Electron 在窗口隐藏时 CDP 视口为 `0x0` → `selector.click()` 报"outside of the viewport"。需先 `Emulation.setDeviceMetricsOverride` 设视口，或在用户实操中走主进程。
- 视口恢复后，`div.ant-select-selector` 的 Playwright click 正常（AntD 监听 mousedown，Playwright 内部已派发 mousedown+mouseup+click）。

---

## 4. 修复（最终代码）

### 4.1 选择器（ctrip.ts）

```ts
const RECOMMEND_APPEND_BUTTON_SELECTOR =
  'span.anticon[style*="rgb(22, 88, 220)"], span.anticon[style*="#1658DC"], span.anticon[style*="#1658dc"]';
```

### 4.2 扩行辅助函数（ctrip.ts）

```ts
async function appendRecommendationRow(page, currentCount) {
  const clicked = await page.evaluate((selector) => {
    const all = document.querySelectorAll("#pm_recommend .ant-form-item");
    if (all.length === 0) return { ok: false, reason: "empty" };
    const last = all[all.length - 1];
    const blues = last.querySelectorAll(selector);
    if (blues.length === 0) return { ok: false, reason: "no-plus", rowCount: all.length };
    blues[blues.length - 1].click();   // 最后一个蓝图标 = +
    return { ok: true, rowCount: all.length };
  }, RECOMMEND_APPEND_BUTTON_SELECTOR);
  if (!clicked.ok) {
    if (clicked.reason === "empty") throw new Error("推荐理由区域为空…");
    throw new Error(`推荐理由最后一行缺少 + 按钮（VBK DOM 异常，行数=${clicked.rowCount}）`);
  }
  // 每次只等「+1 行」出现，多轮在 fillRecommendationReasons 的 while 里驱动
  const expectedCount = currentCount + 1;
  try { await page.waitForFunction(t => rows.length >= t, expectedCount, {timeout: 10_000}); }
  catch { await page.waitForFunction(t => rows.length >= t, expectedCount, {timeout: 5_000}); }
}
```

### 4.3 主循环前扩行

```ts
let currentRowCount = await rows.count();
while (currentRowCount < plan.length) {
  await appendRecommendationRow(page, currentRowCount);
  await delay(150);
  currentRowCount = await rows.count();
}

for (let i = 0; i < plan.length; i += 1) { /* 原有填写逻辑 */ }
```

---

## 5. 测试改造

| 旧 fixture | 新 fixture |
| --- | --- |
| `appendRows: true` → 监听 `textarea.input` 自动追加 | `appendRows: true` → 行末尾渲染 `<span data-action="plus">` 点击追加 |
| 同步追加 | 默认同步；`appendDelayMs` 触发 `setTimeout` 异步追加 |
| — | `index≥1` 时额外渲染 `−` 图标（真实 VBK 视觉） |

### 5.1 用例变动

- 「从一行开始逐组填写并等待页面动态生成三行」→ 改名「从一行开始逐组填写并**通过 + 按钮**生成三行」+ 断言 `plus-click:0/1` 事件序列
- 「前一组填写后页面未生成下一组时抛出明确错误」→ 改名「页面无 + 按钮且行数不足时抛出明确错误」+ 期望 `/推荐理由最后一行缺少 \+ 按钮/`
- 3 个 `duplicateControl/duplicateSection/disableRecommendationCategories` 用例补 `appendRows: true`，让 grow 阶段能成功走到断言失败的环节
- 「异步延迟生成下一行与子控件也能稳定完成」+ 断言 `plus-click` 事件序列
- 「已有三行随机内容时仍逐行重选分类并覆盖文本」+ 断言「已满 3 行不触发 + 按钮」

---

## 6. 验证

- **单元 / 集成**：294/294 通过（`npx tsx --test test/*.test.ts`）
- **TypeScript**：`npm run check` 干净通过
- **真实 VBK 端到端**（`test-e2e-vbk-recommend.mjs`）：
  - 初始 1 行 → `fillRecommendationReasons` 成功扩到 3 行
  - 3 个 combobox 分类全部正确（缤纷景点 / 精选酒店 / 优选行程）
  - 3 个 textarea 文本全部正确

---

## 7. 残余事项（用户后续处理）

- Electron 没在跑时端到端测试无法连；下次有窗口恢复时再跑一次。
- DB 里 `52147893-3b1b-4746-82f3-c3e4b30c47c7` 的 2 个 `blocked` run 可手动清掉，让 readiness 重新计算；本次代码改动不需要动 DB schema。
- VBK 可能对 + 按钮连点 3 次有节流；实测未触发但保留 `waitForFunction` 兜底轮询。