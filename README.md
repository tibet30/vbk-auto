# VBK Desktop

面向旅游产品运营人员的 macOS 桌面工作台：在同一界面完成 AI 多轮规划、资料核查、VBK 登录和安全产品录入。

## 工作流

1. 创建本地产品，和 AI 一起完善行程与产品资料。
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

## 真实 VBK E2E

默认测试不会写入 VBK。需要验证“一款产品的创建和完整录入”时，显式提供已审核的产品 JSON、联系人卡和 400 电话，再运行：

```bash
VBK_LIVE_E2E=1 \
VBK_LIVE_E2E_PRODUCT_FILE=/absolute/path/product.json \
VBK_LIVE_E2E_CONTACT_CARD_ID=123 \
VBK_LIVE_E2E_CONTACT_NAME='联系人姓名' \
VBK_LIVE_E2E_PROVIDER_ID=456 \
VBK_LIVE_E2E_SERVICE_PHONE=4000000000 \
npm run test:e2e
```

该测试只创建草稿、通过 API 录入并执行远端 preflight 回读；不会提审或发布。平台没有已验证的自动回收契约，因此测试草稿会保留，命令输出的产品 ID 应由运营在 VBK 后台人工回收。

## 源码结构

分层与模块职责见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)(单一入口)。粗略三段:

```text
src/
  main/                 Electron 主进程、本地数据库、MiniMax 与自动化服务
    automation/         从原有录入脚本迁入的 VBK 浏览器与表单能力
  renderer/             React 工作台界面
  shared/               主进程与界面共享的类型契约
test/                   自动化与产品协议测试
```

AI 密钥通过桌面端设置保存到 userData 下权限为 0600 的本地文件；renderer 只能读取 `hasKey`，不能取回明文。不要将真实密钥或 VBK Cookie 写入仓库、测试或日志。

## 代码规范

见 [AGENTS.md](/Users/cisco/Documents/vbk-auto/AGENTS.md)。
