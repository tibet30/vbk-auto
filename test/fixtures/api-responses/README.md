# API 响应 fixture 目录（vbk-api）

> 配套：`docs/vbk-api/contract.md §4 脱敏规则`

## 目录约定

```
test/fixtures/api-responses/
├── README.md
├── <endpoint-slug>.json         # 真实抓到的脱敏后端点（一次一个）
└── ...
```

每个 `<endpoint-slug>.json` 形如：

```json
{
  "endpoint": "saveProductBaseInfo",
  "urlPath": "/soa2/..../saveProductBaseInfo",
  "capturedAt": "2026-08-29T...",
  "phase": "basic-info",
  "section": "basic",
  "requestId": "<redacted-trace>",
  "request": { "method": "POST", "headers": { ... }, "body": { ... } },
  "response": { "status": 200, "headers": { ... }, "body": { ... } }
}
```

## 落盘前置（必跑）

按 `contract.md §4` 跑 grep：

```bash
grep -REn "GUID|UBT_VID|vbk_login_cid|xsid|contactCardId=[0-9]{8,}|imageId=[0-9]{8,}|tourInfoId=[0-9]{18,}|手机|电话|身份证|姓名|护照" \
    test/fixtures/api-responses/
```

期望：除字段名 / 路径 / 规则引用外，**0 命中凭据值**。

## 当前状态

阶段 0（2026-08-29）：**0 文件**。

原因：见 `docs/vbk-api/PHASE0-BLOCKED.md §2.2`，登录态不可用，无真实抓包。

## 阶段 1 抓包入口

登录态恢复后：

```bash
cd /Users/cisco/Documents/vbk-auto
PHASE0_OUT_DIR=$(pwd)/docs/vbk-api/phase0-capture \
  node scripts/phase0-capture.mjs
```

随后把 `phase0-capture/phase0-<section>.json` 内的每条端点
按 endpoint 路径切分，逐个写到本目录的 `<endpoint-slug>.json`。
