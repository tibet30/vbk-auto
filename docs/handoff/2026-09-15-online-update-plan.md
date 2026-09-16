# 三人同游在线更新实施方案

日期：2026-09-15

## 目标

在不发布到 App Store / Microsoft Store 的前提下，让三人同游桌面端支持从自有服务器检查、下载并安装新版本。按 2026-09-15 的执行决策，首期先打通 macOS 在线更新准备与本机产物验证；Windows 因暂时缺少真实机器，保留设计位，等设备可用后再验收。

## 当前事实

- 项目使用 Electron + electron-builder。
- 当前发布脚本为 `npm run release:local`，会升版本、检查、测试、打包 macOS universal DMG 和 Windows x64 NSIS 安装包、创建本地提交与 tag，但不会 push。
- Windows 产物是 NSIS 安装包，已有 `.exe.blockmap`。
- macOS 当前只配置 `dmg`；electron-builder 的 macOS 自动更新需要同时产出 `dmg` 与 `zip`。
- macOS 当前有 ad-hoc 签名兜底，正式对客户分发时仍建议使用 Apple Developer ID 签名与 notarization。

## 推荐路线

### 阶段 1：macOS 在线更新

目标：用户从旧版 macOS 安装版打开应用后，应用自动检查服务器上的新版本；发现新版本后由用户确认下载；下载完成后提示用户重启安装。

范围：

- 新增自动更新依赖与主进程更新服务。
- 配置 electron-builder 的 `generic` 更新源。
- macOS target 增加 `zip`，保证自动更新需要的 `latest-mac.yml` 可生成。
- 发布流程增加“生成更新元数据 + 上传到 sx2”的能力。
- 设置页或关于入口增加版本与检查更新状态。
- 只在 macOS 安装版启用自动更新。

不做：

- 不自动提审/发布任何 VBK 产品。
- 不自动 push、部署或覆盖服务器资源，除非用户确认。
- 不启用 Windows 自动更新。
- 不做强制更新；首期采用用户确认重启。

### 阶段 2：Windows 在线更新准备

目标：保留 Windows NSIS 在线更新设计，等有真实 Windows 机器后再启用与验收。

范围：

- 继续沿用 NSIS 安装包与 `.exe.blockmap`。
- 后续准备 `latest.yml` 上传路径。
- 在应用内按平台判断，Windows 未验收前不启用自动更新。

开启条件：

- 有真实 Windows 机器。
- 完成旧版到新版自动更新验收。
- 验证完成页、桌面快捷方式、开始菜单快捷方式仍可启动。

## 服务器资源设计

服务器：`ssh sx2`

建议目录：

```text
/srv/static/sanrentongyou/updates/
  stable/
    latest-mac.yml
    三人同游-1.1.7-universal.dmg
    三人同游-1.1.7-universal.dmg.blockmap
    三人同游-1.1.7-universal.zip
    三人同游-1.1.7-universal.zip.blockmap
    latest.yml
    三人同游-1.1.7-x64-setup.exe
    三人同游-1.1.7-x64-setup.exe.blockmap
```

建议公网 URL：

```text
https://<your-domain>/sanrentongyou/updates/stable/latest-mac.yml
https://<your-domain>/sanrentongyou/updates/stable/latest.yml
```

首期也可以只建：

```text
/srv/static/sanrentongyou/updates/stable/
```

## 客户端更新策略

检查时机：

- 应用启动 10-30 秒后自动检查一次，避免拖慢启动。
- 设置页提供“检查更新”按钮。
- 每 6 小时最多自动检查一次，避免频繁请求服务器。

下载策略：

- 首期发现新版本后提示“发现新版本，是否下载”。
- 下载进度在设置页展示。
- 下载完成后提示“重启并更新”。

失败策略：

- 检查失败只记录日志，不打扰用户。
- 下载失败显示可理解文案，并保留手动下载链接。
- 安装失败不删除原应用，用户仍可继续使用旧版本。

版本策略：

- 仅允许升级到更高 semver 版本。
- 不做自动降级。
- 紧急回滚通过服务器把 `latest-mac.yml` 指回上一个稳定版本；客户端仍会按版本号判断，已升级用户不会自动降级。

## 发布流程设计

建议新增两个命令：

```bash
npm run release:prepare-online:mac
npm run release:upload-online:mac -- --confirm
```

`release:prepare-online:mac`：

- 升版本或读取指定版本。
- 运行现有检查与测试。
- 打 macOS universal `dmg + zip`。
- 后续可选打 Windows x64 NSIS。
- 验证安装包、blockmap、`latest-mac.yml` 是否存在。
- 不上传、不 push、不部署。

`release:upload-online:mac`：

- 仅在用户明确确认后执行。
- 通过 `ssh sx2` 创建版本目录。
- 通过 `scp` 或 `rsync` 上传安装包、blockmap、更新 yml。
- 先上传到临时目录，再原子切换到 stable 目录，避免用户读到半截文件。
- 上传后从公网 URL 读取 `latest-mac.yml` 并校验版本、文件名、sha512。

## 需要修改的代码范围

预计涉及文件：

- `package.json`：新增 `electron-updater` 依赖与发布脚本。
- `electron-builder.yml`：新增 `publish` 配置；macOS 增加 `zip`。
- `src/main/main.ts`：启动后注册自动更新检查。
- `src/main/ipc/update-ipc.ts`：新增更新 IPC 边界。
- `src/main/preload.cts`：暴露 `window.vbk.updates`。
- `src/shared/contracts-api.ts` / `src/shared/contracts-settings.ts`：补更新状态类型。
- `src/renderer/app/views/settings/*`：增加当前版本、检查更新、下载进度、重启更新。
- `scripts/release-local.mjs` 或新增脚本：生成/校验/上传在线更新资源。

如果实现时发现文件行数超过仓库约定，优先拆成独立 `update-service` / `update-ipc` / `update-block`。

## 安全与可信边界

- 更新源必须走 HTTPS。
- `latest-mac.yml` 内的 sha512 由 electron-builder 生成，客户端下载后校验。
- macOS 当前可生成未正式签名的本机验证产物；正式分发建议补 Developer ID 签名与 notarization。
- Windows 后续若沿用未签名安装包，客户会看到系统安全提示；正式分发建议补 Authenticode 签名。
- 服务器上传动作必须单独确认，不和本地打包混在一个默认命令里。

## 验收门

### 本地代码验收

- `npm run check` 通过。
- `npm run test:changed` 通过。
- `npm run build` 通过。
- `npm run package:mac:universal` 能生成 `dmg`、`zip`、blockmap、`latest-mac.yml`。

### 服务器验收

- `ssh sx2` 可访问目标目录。
- 上传后公网能读取 `latest-mac.yml`。
- `latest-mac.yml` 中版本号、文件名、sha512 与本地产物一致。
- 上传过程不会让 stable 目录短暂缺失 `latest-mac.yml` 或安装包。

### macOS 端到端验收

- 安装旧版本，例如 `1.1.6`。
- 服务器 stable 指向新版本，例如 `1.1.7`。
- 旧版应用启动后能发现新版本。
- 下载进度可见或可查询。
- 点击“重启并更新”后，新版启动。
- 新版 `app.getVersion()` 与界面显示均为 `1.1.7`。
- 本地用户数据、AI Key 状态、VBK 登录数据不丢失。
- 若未使用 Developer ID 签名，只能称为本机/内部验证，不作为正式客户验收。

### Windows 准备验收

- 能产出 NSIS 安装包、blockmap、`latest.yml`。
- 不启用线上 Windows 自动更新，除非完成真实 Windows 机器升级测试。

## 回滚方案

- 若新版本还未被用户安装：把服务器 `latest-mac.yml` 指回上一个稳定版本。
- 若新版本已经安装：首期不自动降级，发布更高版本号的修复版。
- 服务器保留最近 3-5 个版本的安装包和 yml，便于人工回退。

## 实施顺序

1. 确认更新源域名和服务器静态目录。
2. 增加 macOS-only 更新服务和 IPC。
3. 增加设置页更新入口。
4. 调整打包配置，让 macOS 生成更新元数据。
5. 新增上传脚本，但默认不上传。
6. 用本地静态服务模拟旧版到新版。
7. 用 `ssh sx2` 上传测试频道资源。
8. 在真实 macOS 机器安装旧版并完成端到端更新验收。
9. 验收通过后再切 stable。

## 待确认问题

1. 更新文件的公网域名是什么？是否已经有 HTTPS？
2. `sx2` 上希望放在哪个目录？是否有现成 Nginx 静态目录？
3. 首期是否只做 macOS 自动更新？
4. 是否接受 macOS 首期作为内部验证继续使用 ad-hoc/未正式签名产物，还是先补 Developer ID？
5. 设置页文案偏“自动下载”还是“发现后询问下载”？

## 参考

- electron-builder Auto Update: https://www.electron.build/auto-update
- electron-builder macOS target note: https://www.electron.build/mac
