# VBK Desktop

面向旅游产品运营人员的 macOS 桌面工作台：在同一界面完成 AI 多轮规划、资料核查、VBK 登录和安全产品录入。

## 工作流

1. 创建本地产品项目，和 AI 一起完善行程与产品资料。
2. 在 VBK 浏览区登录并核对城市、资源组、价格等平台数据。
3. 确认结构化方案后，自动填写并保存 VBK 产品草稿。
4. 用户在 VBK 中人工检查、提审和发布。

桌面端不会自动提审或发布；会话、证据、产品版本和自动化检查点默认保留在本机。

## 开发

```bash
npm install
npm run dev
```

构建并启动：

```bash
npm run start
```

构建 macOS DMG：

```bash
npm run package
```

## 验证

```bash
npm run check
npm test
npm run build
```

### 命令行调试（行程描述）

```bash
npm run pi:itinerary -- <projectId> [cdpPort]
```

示例：

```bash
VBK_CDP_PORT=9496 npm run pi:itinerary -- ff43aae4-3cbf-44c9-8712-c31f219eac46
npm run pi:itinerary -- ff43aae4-3cbf-44c9-8712-c31f219eac46 9496
```

说明：
- `projectId` 为本地项目 ID（`projects` 表中的 `id`）。
- `cdpPort` 默认使用 `VBK_CDP_PORT` 或 `9539`。
- 命令会调用 `node scripts/debug-step.mjs fillItineraryDraft`，用于单独复现行程描述阶段。

## 源码结构

```text
src/
  main/                 Electron 主进程、本地数据库、MiniMax 与自动化服务
    automation/         从原有录入脚本迁入的 VBK 浏览器与表单能力
  renderer/             React 工作台界面
  shared/               主进程与界面共享的类型契约
test/                   自动化与产品协议测试
```

MiniMax 密钥通过桌面端设置保存到 macOS 加密存储；不要将真实密钥或 VBK Cookie 写入仓库。

## 代码规范

见 [AGENTS.md](/Users/cisco/Documents/vbk-auto/AGENTS.md)。
