# VBK Desktop

面向旅游产品运营人员的 macOS / Windows 桌面工作台：在同一界面完成 AI 多轮规划、资料核查、VBK 登录和安全产品录入。

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

本地发布（升版本、检查、测试、打 macOS universal DMG 和 Windows 安装包、提交并创建本地 tag，不 push）：

```bash
npm run release:local          # 默认把 package.json 升一个 patch，例如 1.1.2 -> 1.1.3
npm run release:local -- 1.1.3 # 或显式指定版本
npm run release:local -- --dry-run # 只预览版本和 tag，不改文件
```

发布指令会把 `release/三人同游-<version>-universal.dmg` 和 `release/三人同游-<version>-x64-setup.exe` 都作为必需产物。Windows 安装包推荐在 Windows 机器上构建；在非 Windows 机器上设置 `VBK_ALLOW_CROSS_PACKAGE=1` 时，会复用 `better-sqlite3` 的 Windows 预编译文件并输出未签名安装包。

macOS 在线更新发布（自建更新源，App 内提示用户下载 DMG 后覆盖安装）：

```bash
npm run release:online                # 推荐：打包 macOS + Windows，随后并行上传两套更新文件
npm run release:online -- --dry-run   # 预览，不打包、不上传
npm run release:online:mac
```

这些发布命令固定读取当前 `package.json` 的 `version`，不接收版本参数；要发新版时先改版本号。`release:online` 会运行类型检查，依次构建 macOS universal 包和 Windows x64 安装包，全部校验通过后并行上传两套更新文件到更新源。若 `release/` 中已经存在同版本产物，会直接报错，避免覆盖旧包。

macOS 会生成并上传：

- `release/三人同游-<version>-universal.dmg`
- `release/三人同游-<version>-universal.zip`
- 对应 `.blockmap`
- `release/latest-mac.yml`

Windows 会生成并上传：

- `release/三人同游-<version>-x64-setup.exe`
- `release/三人同游-<version>-x64-setup.exe.blockmap`
- `release/latest.yml`

当前无 Developer ID / Windows 签名时，App 不做静默自动替换安装；用户在 App 设置页检查到新版后，下载安装包，打开安装包并按提示覆盖旧版。`latest-mac.yml` 仍保留 zip 路径，方便以后有 Developer ID 签名后恢复真正的自动安装。

上传脚本会把安装包、blockmap 和平台清单放到服务器的稳定更新目录。默认目标为 `sx2:/data/www/web/downloads/sanrentongyou/updates/stable`，可用环境变量覆盖：

```bash
VBK_UPDATE_SSH_HOST=sx2 \
VBK_UPDATE_REMOTE_ROOT=/data/www/web/downloads/sanrentongyou/updates \
npm run release:online
```

上传后读取线上清单确认：

```bash
curl -fsSL https://www.atdtour.com/downloads/sanrentongyou/updates/stable/latest-mac.yml
curl -fsSL https://www.atdtour.com/downloads/sanrentongyou/updates/stable/latest.yml
```

总发布执行流程：

1. 读取当前 `package.json` 的 `version`。
2. 如果 `release/` 中已经有同版本 macOS 或 Windows 产物，立即失败。
3. 运行 `npm run check`。
4. 运行 `npm run package:mac:universal`。
5. 运行 `npm run package:win`（非 Windows 机器会自动使用 `VBK_ALLOW_CROSS_PACKAGE=1` 交叉构建未签名安装包）。
6. 校验 `latest-mac.yml`、`latest.yml` 与所有安装包/blockmap。
7. 并行上传 macOS 与 Windows 更新文件到更新源。

Windows 在线更新发布（自建更新源，App 内提示用户下载 EXE 安装包后覆盖安装）：

```bash
npm run release:online:win -- --dry-run
npm run release:online:win
```

该命令固定读取当前 `package.json` 的 `version`，不接收版本参数；要发新版时先改版本号。执行时会运行类型检查、构建 Windows x64 NSIS 安装包，校验产物，然后上传到更新源：

- `release/三人同游-<version>-x64-setup.exe`
- `release/三人同游-<version>-x64-setup.exe.blockmap`
- `release/latest.yml`

Windows 安装包推荐在 Windows 机器上构建；在非 Windows 机器上执行该命令时，会自动设置 `VBK_ALLOW_CROSS_PACKAGE=1` 做未签名交叉构建，仅适合生成当前过渡阶段的手动安装包。真正的 Windows 安装、覆盖升级、开始菜单/桌面快捷方式验收仍需要 Windows 机器执行。

上传后读取线上清单确认：

```bash
curl -fsSL https://www.atdtour.com/downloads/sanrentongyou/updates/stable/latest.yml
```

构建 Windows 安装包：

```bash
npm run package:win
```

Windows 安装包需要在 Windows 机器上构建，确保 `better-sqlite3` 等原生依赖按 Windows 目标重新安装/重建。构建产物会输出到 `release/`，文件名形如 `三人同游-1.1.0-x64-setup.exe`。

## 验证

```bash
npm run check
npm test          # 只运行本次 Git 改动直接或间接影响的单元测试
npm run test:changed  # 按改动筛选全部测试层
npm run test:all  # 显式全量回归
npm run build
```

## 真实 VBK E2E

默认测试不会写入 VBK。需要验证“一款母产品、飞机往返和火车往返子产品的创建、完整录入与聚合回读”时，显式提供已审核的产品 JSON、联系人卡和 400 电话，再运行：

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
