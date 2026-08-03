# Topbar 极简单层重构 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 topbar 从 48px 双层结构收紧为 44px 单层极简结构，去除冗余胶囊装饰，对齐 Linear / Raycast 等 macOS 生产工具的紧凑视觉语言。

**Architecture:** 调整 `--topbar` 变量与 `.topbar` padding，新增 `.topbar-status-chip` 行内样式定义，去除 `.crumb-action` / `.crumb-state` 的胶囊背景，最后同步 DESIGN.md 规范。零新组件、零新 state、零新依赖。

**Tech Stack:** React 19.2 + TypeScript + Vite；样式用现有 CSS 变量系统（`--topbar`, `--pad`, `--border`, `--muted-foreground`, `--foreground`, `--success-green`, `--warning-amber`, `--ai-teal`）。

## Global Constraints

来自 spec (`docs/superpowers/specs/2026-08-02-topbar-minimal-refactor-design.md`)：

- 高度变量：`--topbar: 44px`（从 48px 收紧）
- 水平 padding：`12px`（从 16px 收紧）
- chip 样式：行内「文字 + dot」，**不画背景框**
- 底部 1px border：保留 `var(--border)`
- 分组：左侧身份区 + `topbar-spacer` 撑开 + 右侧操作区
- 不改 rail（56px）、不改 stage-nav、不改窗口标题栏、不动 `.notice`
- 不重命名类名、不新增视觉资源或字体
- 不迁移状态徽标到 stage-nav

字号规范（DESIGN.md:62-69）：正文 13px、辅助 12px、紧凑 10-11px、工作区标题 20-22px。
topbar 内 `VBK Desktop` = 13px medium muted；项目名 = 14px semibold foreground；状态文字 = 12px muted。

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `src/renderer/styles.css` | 修改 | 调整 `--topbar`、`.topbar` padding、`.crumb-action`、`.crumb-state`；新增 `.topbar-status-chip` 行内样式 |
| `src/renderer/App.tsx` | 修改（无结构变更） | 保留 JSX，依赖类名语义调整 |
| `DESIGN.md` | 修改 | topbar-height 规范更新 |

无新文件创建。修改三处文件，全部聚焦 topbar 单一职责。

---

## Task 1: 收紧 `--topbar` 变量与 `.topbar` 容器 padding

**Files:**
- Modify: `src/renderer/styles.css:52`（变量声明）
- Modify: `src/renderer/styles.css:313-324`（`.topbar` 容器）

**Interfaces:**
- 无（仅 CSS 变量与容器规则）

- [ ] **Step 1: 修改 `--topbar` 变量从 48px 到 44px**

在 `src/renderer/styles.css:52` 把 `--topbar: 48px;` 改为 `--topbar: 44px;`。

预期 diff：
```diff
-  --topbar: 48px;
+  --topbar: 44px;
```

- [ ] **Step 2: 修改 `.topbar` padding 从 `0 var(--pad)` 到 `0 12px`**

在 `src/renderer/styles.css:319` 把 `padding: 0 var(--pad);` 改为 `padding: 0 12px;`。

预期 diff：
```diff
-  padding: 0 var(--pad);
+  padding: 0 12px;
```

注意：`height: var(--topbar)` 与 `min-height: var(--topbar)` 自动从 48px 收缩到 44px，**不需要再改这两行**。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/styles.css
git commit -m "style: tighten topbar to 44px with 12px horizontal padding"
```

---

## Task 2: 新增 `.topbar-status-chip` 行内样式

**Files:**
- Modify: `src/renderer/styles.css`（在 `.topbar-spacer`（约行 464）之前新增）

**Interfaces:**
- 无（纯样式新增）

`.topbar-status-chip` 当前在 App.tsx:491 被使用，但 styles.css 中**没有对应的样式定义**——它现在是裸 div，靠默认 block 布局显示。新增规则把它定义为「行内文字 + dot」。

- [ ] **Step 1: 在 `.topbar-spacer` 之前插入 `.topbar-status-chip` 样式块**

在 `src/renderer/styles.css` 第 464 行 `.topbar-spacer { flex: 1; min-width: 0; }` 之前插入以下规则：

```css
.topbar-status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted-foreground);
  padding: 0;
  background: transparent;
  border: none;
  flex-shrink: 1;
  min-width: 0;
}

.topbar-status-chip strong {
  font-weight: 600;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.topbar-status-chip .dot { width: 6px; height: 6px; }
```

要点：
- 没有 `border`、`background`（去除胶囊框）
- 没有 `border-radius`（非胶囊）
- `padding: 0`（行内元素）
- `font-size: 12px` 对齐辅助文字
- 内部 `<strong>` 加粗显示数字，符合原胶囊样式视觉重心

- [ ] **Step 2: 提交**

```bash
git add src/renderer/styles.css
git commit -m "style: define topbar-status-chip as inline dot+text"
```

---

## Task 3: 去除 `.crumb-action` 胶囊装饰

**Files:**
- Modify: `src/renderer/styles.css:348-361`

**Interfaces:**
- 无

`.crumb-action` 当前是 28px 高的胶囊按钮（透明背景但有边框占位），让「项目」返回按钮视觉上偏重。改为纯文字 chevron 链接。

- [ ] **Step 1: 简化 `.crumb-action` 规则**

把 `src/renderer/styles.css:348-361` 整段替换为：

```css
.crumb-action {
  display: inline-flex;
  align-items: center;
  height: auto;
  padding: 0;
  border-radius: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted-foreground);
  background: transparent;
  border: none;
  transition: color 160ms ease;
  flex-shrink: 0;
}

.crumb-action:hover { color: var(--foreground); }
```

要点：
- `height: 28px` → `auto`（不再强制胶囊高度）
- `padding: 0 12px` → `0`（不画胶囊内部留白）
- `border-radius: 999px` → `0`（不画圆角）
- `border: 1px solid transparent` → `none`（不画占位边框）
- hover 仅变前景色（不再有 background 变化）

- [ ] **Step 2: 提交**

```bash
git add src/renderer/styles.css
git commit -m "style: drop pill decoration from crumb-action"
```

---

## Task 4: 去除 `.crumb-state` 胶囊背景

**Files:**
- Modify: `src/renderer/styles.css:402-414`

**Interfaces:**
- 无

`.crumb-state` 当前是 999px 圆角的胶囊（小字+dot+背景+边框）。改为行内文字+dot，与状态 chip 视觉一致。

- [ ] **Step 1: 简化 `.crumb-state` 规则**

把 `src/renderer/styles.css:402-414` 整段替换为：

```css
.crumb-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted-foreground);
  padding: 0;
  background: transparent;
  border: none;
  flex-shrink: 0;
}

.crumb-state .dot { width: 6px; height: 6px; }
```

要点：
- `border-radius: 999px` → 移除
- `padding: 2px 8px 2px 6px` → `0`
- `background: var(--surface)` → `transparent`
- `border: 1px solid var(--border)` → `none`
- 保留 dot 大小（行 416 已存在）
- `gap` 从 6px 调到 4px，因为不再需要为胶囊内边距预留空间

- [ ] **Step 2: 提交**

```bash
git add src/renderer/styles.css
git commit -m "style: drop pill decoration from crumb-state"
```

---

## Task 5: 同步 DESIGN.md 规范

**Files:**
- Modify: `DESIGN.md:23`
- Modify: `DESIGN.md:74`

**Interfaces:**
- 无

- [ ] **Step 1: 更新 layout.topbar-height**

在 `DESIGN.md:23` 把 `topbar-height: 48px` 改为 `topbar-height: 44px`。

预期 diff：
```diff
-  topbar-height: 48px
+  topbar-height: 44px
```

- [ ] **Step 2: 更新 Application Shell 段落**

在 `DESIGN.md:74` 把 `A 48px top bar` 改为 `A 44px top bar`。

预期 diff：
```diff
-- A 48px top bar shows the current product, VBK login/account state, readiness, and the safe save-draft action.
+- A 44px top bar shows the current product, VBK login/account state, readiness, and the safe save-draft action.
```

- [ ] **Step 3: 提交**

```bash
git add DESIGN.md
git commit -m "docs: sync topbar-height spec to 44px"
```

---

## Task 6: 类型检查与测试

**Files:**
- 无（运行命令）

**Interfaces:**
- 无

- [ ] **Step 1: 运行类型检查**

```bash
npm run check
```

预期：通过。`--topbar` 是 CSS 变量，`App.tsx` 不直接引用，不影响 TypeScript 类型。

注意：项目工作树中存在**预先存在**的类型错误（`src/main/preload.cts`、`src/main/butler-contacts.ts`、`src/main/manual-review-field.ts`）来自更早的修改。**这些与本任务无关，不应被视为回归**。验收标准：本次修改引入的新错误数为 0。

- [ ] **Step 2: 运行测试套件**

```bash
npm test
```

预期：157 个测试全部通过，无新增失败。

- [ ] **Step 3: 视觉验证（手动）**

```bash
npm run dev
```

依次确认：
1. 无项目时：topbar 显示「VBK Desktop」+ 右侧账号 chip；标题距离顶部约 8-10px，整体重心居中
2. 有项目时：topbar 显示「项目 › 项目名 · 等待确认」；状态徽标为行内文字+dot，无胶囊背景
3. readiness chip：行内「● 60% · 2 项待处理」，与账号 chip 同一基线
4. 高度变化：与之前对比明显紧凑，整体高度从 48px 变为 44px
5. 响应式：窗口 ≤ 880px 时 status chip 隐藏（现有规则生效）

- [ ] **Step 4: 提交（如有调整）**

如有视觉微调（如 padding、gap 数值），按需调整后单独 commit。不强制提交。