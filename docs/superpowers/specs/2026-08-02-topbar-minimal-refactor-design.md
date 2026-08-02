---
title: Topbar 极简单层重构
status: approved
date: 2026-08-02
---

# Topbar 极简单层重构

## Context

用户反馈顶栏（`.topbar`）整体偏松散：
- `VBK Desktop` 标题距离 topbar 顶部空白过大，视觉重心偏低
- 「项目」返回按钮、状态徽标胶囊背景、状态 chip 圆角容器叠加在一起占据过多垂直空间
- 与「紧凑、克制、操作工具」的 DESIGN.md 视觉语言存在落差

**根因**：
- `styles.css:52` 设定 `--topbar: 48px`，加之 padding `0 var(--pad)`（16px）以及内部 chip 的高度叠加，导致内容垂直居中后视觉上偏下
- 多余的胶囊背景（`topbar-status-chip`、`crumb-state`、`crumb-action`）违反「用边框和留白而非阴影/底色来分组」的 DESIGN.md 视觉原则

**期望**：参考 Linear / Raycast / Arc 等 macOS 生产工具的紧凑 topbar，将顶栏收紧到 44px 单层结构，去除冗余视觉装饰，让标题与身份区明确。

## Approach

按方案 A「极简单层」实施：
1. 高度从 48px 收紧到 44px（macOS HIG 推荐工具栏高度）
2. 左右 padding 从 16px 收紧到 12px
3. 状态 chip 由「胶囊背景容器」改为「行内文字 + dot」，与右侧账号 chip 在同一基线对齐
4. 「项目」返回按钮（`.crumb-action`）去除胶囊装饰，改为纯文字 chevron 链接
5. 项目状态徽标（`.crumb-state`）去除胶囊背景，改为内联小字 + dot

## Critical Files to Modify

### 1. `src/renderer/styles.css`

- 第 52 行 `--topbar: 48px` → `44px`
- 第 313-324 行 `.topbar`：`padding: 0 var(--pad)` → `padding: 0 12px`；高度由变量驱动
- `.topbar-status-chip`（约 410 行附近）：去掉背景/边框/圆角，改为透明背景的 flex 行内元素
- `.crumb-action`（348-361 行）：去掉胶囊装饰，改为透明行内元素
- `.crumb-state`（约 470 行附近）：去掉胶囊背景，改为内联文字+dot
- 顶部 status 区内的 `.topbar-status` chip 同理调整

### 2. `src/renderer/App.tsx`

- 第 468-547 行 `<header className="topbar">`：结构不变，去掉冗余的 `className="crumb-state"` 胶囊背景所需的属性；保留所有交互与可访问性属性
- 不新增组件，不改 props

### 3. `DESIGN.md`

- 第 23 行 `topbar-height: 48px` → `44px`
- 第 74 行 "A 48px top bar" → "A 44px top bar"

## Design Decisions

### 视觉规范
- **高度**：`--topbar: 44px`（统一变量驱动，rail 与 main grid 同步更新）
- **水平 padding**：`12px`
- **垂直**：依赖 `align-items: center` 实现单行垂直居中，不再额外加 padding-top/bottom
- **底部 1px border**：`var(--border)` 保留作为与下方内容的唯一分隔
- **分组**：左侧为身份区，右侧为操作区，中间 `topbar-spacer` 撑开
- **chip 样式**：行内 `文字 + dot`，不画背景框；dot 颜色语义保留（绿=ok、amber=warn、teal=ai）

### 字号
- 标题 `VBK Desktop`：13px medium `var(--muted-foreground)`
- 项目名：14px semibold `var(--foreground)`
- 状态文字：12px regular `var(--muted-foreground)`

### 字号规范对齐 DESIGN.md
- 正文与工作区文字 13px（DESIGN.md:65）
- 标签与辅助文字 12px（DESIGN.md:66）
- 工作区标题 20-22px bold（DESIGN.md:67）

topbar 内的「VBK Desktop」与「项目名」不属于工作区标题，按"辅助文字 + 正文"字号处理是合理的。

## Data Flow

无新数据流。现有 state（`project`, `vbkLogin`, `readiness`, `providerIdDisplay`, `view`）足够驱动新结构：
- `!project` → 显示「VBK Desktop」单字标题
- `project && view === "workspace"` → 显示项目名 + 内联状态徽标 + readiness chip + 「保存草稿」按钮
- `!project && view !== "workspace"` → 仅显示「VBK Desktop」+ 账号 chip

不引入新 props、不新增 state、不改 IPC 契约。

## Error Handling

本次重构不涉及错误处理路径。所有现有的错误显示路径（`.notice` 自动消失、stage-nav 状态更新、rail 状态指示）保持不变。

## Testing

### 类型与构建
- `npm run check`：确保类型检查通过
- `npm run build`：确保 Vite 构建产物无新警告

### 单元测试
- `npm test`：现有 18 个测试文件 / 157 用例均为主进程业务逻辑，不涉及渲染端 topbar，应全部通过

### 视觉验证（手动）
1. `npm run dev` 启动应用
2. **无项目时**：topbar 显示「VBK Desktop」+ 右侧账号 chip；视觉上标题距离 topbar 顶部应明显比之前紧凑（约 8-10px），重心居中
3. **有项目时**：topbar 显示「项目 › 项目名 · 等待确认」；状态徽标不再占用额外垂直空间
4. **readiness chip**：变为行内「● 60% · 2 项待处理」样式，与账号 chip 视觉基线对齐
5. **响应式**：窗口宽度 ≤ 880px 时右侧 status chip 自动隐藏（现有 `@media (max-width: 880px)` 规则已生效）
6. **可访问性**：键盘 Tab 顺序、aria-label、focus ring 与改造前一致

## Out of Scope

- 不改 rail（56px 不变）
- 不改 stage-nav（其下方的两步进度导航）
- 不改 macOS 窗口标题栏区域（属于 Electron BrowserWindow 配置）
- 不动 `.notice` 提示条（与本任务无关）
- 不重命名类名（保留 `.topbar`、`.crumb`、`.topbar-status-chip` 等向后兼容命名）
- 不新增视觉资源或字体
- 不迁移项目状态徽标到 stage-nav（状态徽标仍在 topbar 内联显示，只是去掉胶囊背景）