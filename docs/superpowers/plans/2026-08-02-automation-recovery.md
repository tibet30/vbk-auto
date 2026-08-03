# MiniMax 自动录入诊断 + 受限自修正 + 三次后停住 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 VBK Desktop 的自动录入失败从"日志一行 error"变成"调用 MiniMax 给出受控的可执行建议 → 同一阶段最多 3 次自动重试 → 第 3 次仍失败停住等待用户"，并由 Codex 最终复核 + 真实 VBK 验收。

**Architecture:** 抽出一个本地纯函数 `runPhaseWithRecovery`（在 main 进程），用 recovery runner 包裹每个阶段的 handler：第一次失败先记录安全错误，再调用注入进来的 advisor；当 advisor 自己也失败或返回白名单之外的指令，runner 立即按 `wait_for_user` 停住。MiniMaxService 在 `reply/generateField` 之外新增一个独立方法 `diagnoseAutomationFailure`，使用 OpenAI tool / function schema，并把严格 zod 校验过的对象返回给 runner；不污染 patch 协议。AutomationRun 契约增加 `recovery` 状态，UI 在自动录入进度面板下清楚显示诊断、每次尝试、停住原因。basic 阶段也走同一 runner，复用既有的 `fillAndSaveBasicInfo` + tab 解锁门禁；checkpoint 不重跑；productId 永远 open existing editor，绝不创建新草稿。reload/reopen 后只能执行白名单中的保存草稿动作，绝不允许提审、发布、上线。

**Tech Stack:** TypeScript 7 (Node 18 test runner + tsx)、OpenAI 7 SDK、zod 4、Electron 43 主进程、React 19 + lucide-react、better-sqlite3。`tsx --test test/**/*.test.ts` 跑测；`tsc --noEmit && tsc -p tsconfig.renderer.json` 做类型检查。

## Global Constraints

1. MiniMax 给自动录入用的回复**只能是**严格结构化 diagnosis，定义如下；任何额外字段 / 自由文本 / 代码 / 选择器 / URL / 脚本 / 页面动作一律丢弃。
   - `summary`: 中文一句话，≤80 字，陈述假设。
   - `rootCause`: 中文，基于已给证据，不编造未观察事实，≤200 字。
   - `action`: 枚举 **且只能** 是 `retry_same_phase` / `reload_and_retry_phase` / `reopen_editor_and_retry_phase` / `wait_for_user`。
   - `expectedEvidence`: 中文短句，≤120 字，成功应该看到什么。
   - `userInstruction`: 仅当 `action = wait_for_user` 必填，其余情况忽略；中文，可执行的"请你在 VBK 做什么"。
2. 发给 MiniMax 的 system + user prompt 必须明确包含：`phase`、`attempt`（第几次失败，从 1 起始）、`errorMessage`（脱敏后文本）、`attemptsSummary`（仅限已发生过的 action + errorMessage + expectedEvidence，**不含** DOM/cookie/键/表单/产品敏感 JSON）、`allowedActions`（白名单）、`hardConstraints`（"只返回唯一 action、不要给代码/选择器/URL、不要提审、发布、上线、删除、修改库存价格、不要重复 production patch 协议"）。
3. 发送的最小上下文：**只包含** `projectId`（随机 UUID，没有含义）、`phase`、`attempt`、`errorMessage`、`productIdExists: boolean`、`basicInfoSaved: boolean`、`completedPhases: string[]`、`diagnosisHistory: { summary; rootCause; action; expectedEvidence }[]`。**绝不发送** DOM、cookie、API key、联系人、400 电话、表单全文、完整产品 JSON、产品图片、供应商 ID、providerId、`vbkApiKey`、当前页面 URL、未在白名单的 patch 路径。
4. 使用 OpenAI function tool `submit_failure_diagnosis`，其 `parameters` 即为诊断 schema；本地用 `zod.strict()` 二次校验；provider error 走现有 `throwProviderError` 逻辑，不污染主 reply/patch 协议。MiniMaxService 日志**禁止**记录 raw response / tool arguments；只记录 `phase`、`attempt`、`action`、`errorCode`、`elapsedMs`。
5. DraftAutomation 通过构造函数注入 `advisor: (input: AdvisorRequest) => Promise<AdvisorOutcome>`。生产路径里 main.ts 用当前 MiniMax 配置 + key 构造 MiniMaxService，再闭包出一个 advisor；测试用假的 advisor。**DraftAutomation 不能自己读密钥**。
6. 统一 recovery runner：每个 phase 最多 **MAX_PHASE_ATTEMPTS = 3** 次（含首次）。`phase.attempt = 1..3`。runner 行为：
   - 调用 handler，捕获 error → `safeError = stripSensitive(error)`。
   - 第一次失败：调用 advisor；如果 advisor 自身抛错 / 返回非法 shape → 记录 `"MiniMax 诊断失败"`，等价 `wait_for_user`。
   - 如果 `attempt >= 3`（无下一次）→ 不论 advisor 返回什么 action 都不执行其修复动作，直接 `state = needs_user`、最终 `status = blocked`。
   - 只有当 `attempt < 3` 且 action ∈ 白名单动作（retry/reload/reopen），才做：
     - `retry_same_phase` → 再次执行同一 handler。
     - `reload_and_retry_phase` → `page.reload({ waitUntil: 'domcontentloaded' })`；若 `productIdExists` 再 `openProductEditor(productId)`，再执行 handler。
     - `reopen_editor_and_retry_phase` → 仅当 `productIdExists`，否则降级为 `retry_same_phase`；执行 `openProductEditor(productId)`，再执行 handler。
     - `wait_for_user` → 立即设置 `state = needs_user`、`status = blocked`，停止。
   - reload/reopen 之后**只能**再次执行当前白名单阶段的 handler；不调用 `configureProductShell/createProductShell`；不调用任何提交/发布/上线 API。
7. basic 阶段专属：`fillAndSaveBasicInfo` 内部已经做 tab 解锁门禁；`db.setBasicInfoSaved` 只在 VBK 真实保存后置位。如果 basic 是失败阶段，runner 仍走同一套 3 次重试；不创建新草稿（productId 存在永远 `openProductEditor`，没有才 `configureProductShell + createProductShell`，由产物 `productId` 的旧分支保留）。
8. advisor 内部也走 `try/catch` + zod 校验，捕获后记录 `"MiniMax 诊断失败: <reason>"`，按 `wait_for_user` 等价处理（不盲目重试）。
9. AutomationRun 契约扩展：
   ```ts
   interface PhaseAttempt {
     attempt: number;          // 1..3
     error: string;            // 已脱敏
     diagnosis?: { summary: string; rootCause: string; expectedEvidence: string };
     action?: "retry_same_phase" | "reload_and_retry_phase" | "reopen_editor_and_retry_phase" | "wait_for_user";
     at: string;
   }
   interface PhaseRecovery {
     phase: string;
     state: "running" | "advising" | "retrying" | "needs_user" | "completed";
     attempts: PhaseAttempt[];
     userInstruction?: string;
     finalError?: string;
   }
   interface AutomationRun {
     // 已有字段保留
     recovery?: { phases: Record<string, PhaseRecovery> };
   }
   ```
   `recovery.phases[phase].state` 是 UI 取值的唯一真相。
10. UI 在 Workspace 的"自动录入进度"区段，当 `state === 'needs_user'` 时：清楚显示 "已停止，等待用户处理"、展示 `userInstruction` 与最近一次 `rootCause`，并把"保存草稿"按钮恢复为可点（用户点后重新开始新一轮；新一轮独立计数 3 次，不会自动接力）。诊断历史在同一面板内以时间顺序列出，最多保留最近 3 次（避免 UI 越长越长）。
11. 严禁触碰 `pickupCity/transport/inventory` 等提交/发布链路；保留 `package: 'desktop-draft'` 截图逻辑；不改 `package`/`pricing`/`inventory` 字段的现有写入接口；不改任何 ipc handler 名。

## File Structure

| 文件 | 新/改 | 责任 |
| --- | --- | --- |
| `src/main/minimax.ts` | 改 | 新增 `diagnoseAutomationFailure`、严格 zod schema、调用相同的 OpenAI 客户端和服务错误映射。日志零 raw response。 |
| `src/shared/contracts.ts` | 改 | 扩展 `AutomationRun` 增加 `recovery`，新增 `PhaseRecovery` / `PhaseAttempt` / `AdvisorOutcome` / `AdvisorRequest` 类型。 |
| `src/main/automation/recovery.ts` | 新增 | 纯函数 `runPhaseWithRecovery(phase, handler, advisor, ctx)`，决定 MAX_PHASE_ATTEMPTS、attempt index、action 映射、状态写入。 |
| `src/main/automation.ts` | 改 | 构造函数注入 `advisor`；每个 phase handler 接到 runner；状态写入 `run.recovery`。basic 阶段也走 runner，绝不重建草稿。 |
| `src/main/main.ts` | 改 | 用当前 MiniMax 配置 + `apiKey()` 构造 service，再构造 advisor，注入 DraftAutomation。 |
| `src/renderer/App.tsx` | 改 | 替换"自动录入进度"区段为从 `recovery` 推导的展示（含 advising badge、attempt 列表、needs_user 详情、保存草稿按钮恢复文案）。 |
| `test/minimax.test.ts` | 改 | 新增 `diagnoseAutomationFailure` 的服务端 mock；正路径、严格 schema 拒绝额外字段、provider 错误映射、日志不写 raw response。 |
| `test/automation-recovery.test.ts` | 新增 | runner 单测：首次成功不调 advisor；失败一次 → diagnosis + retry 成功；reload 映射；reopen 映射需要 productId；无 productId 的 reopen 降级为 retry；wait_for_user 立即停；advisor 抛错 → 按 needs_user；attempt=3 后不再调 advisor（用 advisor.calls.length 断言）；连续 3 次失败 → `needs_user` 且 attempts 长度 = 3；现有 204 测试不回归（基本全部沿用，只新增）。 |

---

## Task 1: 扩展 AutomationRun 契约 + 新增 recovery 类型

**Files:**
- Modify: `src/shared/contracts.ts:67-74`
- Test: `test/automation-recovery.test.ts`(占位，仅导入声明)

**Interfaces:**
- Produces: `PhaseAttempt`、`PhaseRecovery`、`RecoveryState`、`AdvisorRequest`、`AdvisorOutcome`、`AdvisorAction` —— 全部 export 出去供 minimax.ts 和 recovery.ts 使用。

- [ ] **Step 1: 写失败测试驱动契约存在**

在 `test/automation-recovery.test.ts` 顶部加上 `import type { PhaseRecovery, AdvisorAction } from "../src/shared/contracts.js";` 以及一个待实现后会通过的空测试体，仅用于核实类型导出：
```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { AdvisorAction, PhaseRecovery } from "../src/shared/contracts.js";

test("recovery 契约暴露给 runner 与 advisor", () => {
  const sample: PhaseRecovery = { phase: "basic", state: "running", attempts: [] };
  const action: AdvisorAction = "retry_same_phase";
  assert.equal(sample.state, "running");
  assert.equal(action, "retry_same_phase");
});
```

- [ ] **Step 2: 运行测试，应该失败（类型未导出）**

Run: `npm test -- test/automation-recovery.test.ts`
Expected: 报错 `Module '"../src/shared/contracts.js"' has no exported member 'AdvisorAction' / 'PhaseRecovery'`。

- [ ] **Step 3: 在 `src/shared/contracts.ts` 加新类型**

定位 `AutomationRun` interface（行 67 附近），在其上方插入：
```ts
export type AdvisorAction =
  | "retry_same_phase"
  | "reload_and_retry_phase"
  | "reopen_editor_and_retry_phase"
  | "wait_for_user";

export interface AdvisorRequest {
  phase: string;
  attempt: number;            // 1..3
  error: string;              // 已脱敏
  productIdExists: boolean;
  basicInfoSaved: boolean;
  completedPhases: string[];
  diagnosisHistory: Array<{
    summary: string;
    rootCause: string;
    action: AdvisorAction;
    expectedEvidence: string;
  }>;
}

export interface AdvisorOutcome {
  summary: string;
  rootCause: string;
  action: AdvisorAction;
  expectedEvidence: string;
  userInstruction?: string;
}

export type RecoveryState =
  | "running"
  | "advising"
  | "retrying"
  | "needs_user"
  | "completed";

export interface PhaseAttempt {
  attempt: number;
  error: string;
  diagnosis?: { summary: string; rootCause: string; expectedEvidence: string };
  action?: AdvisorAction;
  at: string;                 // ISO timestamp
}

export interface PhaseRecovery {
  phase: string;
  state: RecoveryState;
  attempts: PhaseAttempt[];
  userInstruction?: string;
  finalError?: string;
}
```
然后在 `AutomationRun` interface 里加一个可选字段：
```ts
recovery?: { phases: Record<string, PhaseRecovery> };
```

- [ ] **Step 4: 跑测试验证**

Run: `npm test -- test/automation-recovery.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑全量，确认 204 测试不回归**

Run: `npm test`
Expected: 全部 PASS（仅新增一个测试）。

---

## Task 2: MiniMaxService 新增 diagnoseAutomationFailure

**Files:**
- Modify: `src/main/minimax.ts`(在 `reply` 之后；保留 reply/generateField 行为)。
- Test: `test/minimax.test.ts`(新增 `describe`/`test`，不破坏现有)。

**Interfaces:**
- Consumes: `AdvisorRequest`。
- Produces: `AdvisorOutcome`。

- [ ] **Step 1: 写失败测试**

在 `test/minimax.test.ts` 文件末尾追加；不要在 `test()` 块外，要用一个外层 `test("diagnoseAutomationFailure 正常路径", ...)`。

需要覆盖的至少 6 条用例（一次写 6 个 test 块，每块用独立 http server；保证并行 server 互不干扰）：
1. 返回严格 schema 时解析成功，断言字段相等；
2. 返回含额外字段（`hint`、`remediationCode`）时 zod strict 拒绝 → 抛 `invalid_model_output`；
3. 返回 `action` 为不在白名单的值（`please_call_user`、`generate_patch`）→ strict 拒绝；
4. provider 返回 401 → 抛 `provider_authentication`；
5. provider 返回 500 → 抛 `provider_error`；
6. 日志不写 raw response：用 `console.warn` spy 捕获调用，断言任意调用都没有 `response.text` / `function.arguments` 字面量。

示例第 1 条（其余 5 条照搬，需要不同 server 与不同 payload）：
```ts
test("diagnoseAutomationFailure 严格解析白名单 reply", async (t) => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{
      id: "call_1", type: "function",
      function: { name: "submit_failure_diagnosis", arguments: JSON.stringify({
        summary: "基础信息可能未真正落库。",
        rootCause: "保存按钮的回调在 VBK 出现错误，提示信息未读出。",
        action: "retry_same_phase",
        expectedEvidence: "运行结束后产品状态变为「基本信息已保存」，且产品图文 tab 可点击。",
      }) },
    }] } }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const service = new MiniMaxService({ apiKey: "k", baseUrl: `http://127.0.0.1:${addr.port}/v1`, model: "m" });
  const outcome = await service.diagnoseAutomationFailure({
    phase: "basic",
    attempt: 1,
    error: "保存失败：原因未知",
    productIdExists: true,
    basicInfoSaved: false,
    completedPhases: [],
    diagnosisHistory: [],
  });
  assert.equal(outcome.action, "retry_same_phase");
  assert.match(outcome.expectedEvidence, /tab/);
});
```

第 6 条（敏感字符串断言）核心：用一个故意抛出 `provider_error` 的服务（关闭 server），捕获任意 `console.warn` 调用，确保调用字符串里既没有请求 body，也没有 tool arguments。
```ts
test("诊断失败时日志不写原始请求或响应", async (t) => {
  const seen: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { for (const a of args) seen.push(String(a)); };
  t.after(() => { console.warn = originalWarn; });
  const server = createServer((_req, res) => { res.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const service = new MiniMaxService({ apiKey: "k", baseUrl: `http://127.0.0.1:${addr.port}/v1`, model: "m" });
  await assert.rejects(service.diagnoseAutomationFailure({
    phase: "basic", attempt: 1, error: "x", productIdExists: false, basicInfoSaved: false, completedPhases: [], diagnosisHistory: [],
  }));
  const joined = seen.join("\n");
  assert.equal(/retry|action|function\.arguments|response|body/i.test(joined) && !/provider_error|MiniMax/.test(joined), false);
});
```

- [ ] **Step 2: 跑测试，应该全部失败**

Run: `npm test -- test/minimax.test.ts`
Expected: 6 个新增用例 FAIL（`service.diagnoseAutomationFailure is not a function`）。

- [ ] **Step 3: 实现 `MiniMaxService.diagnoseAutomationFailure`**

位置：`MiniMaxService` class 内，紧接 `generateField` 之后。

实现要点：
1. 定义 `diagnosisTool`：`type: "function"`，name `submit_failure_diagnosis`，parameters 使用 inline jsonSchema：
   ```ts
   const diagnosisTool = {
     type: "function",
     function: {
       name: "submit_failure_diagnosis",
       description: "返回自动录入阶段失败的结构化诊断。",
       parameters: {
         type: "object",
         additionalProperties: false,
         required: ["summary", "rootCause", "action", "expectedEvidence"],
         properties: {
           summary: { type: "string", minLength: 1, maxLength: 200 },
           rootCause: { type: "string", minLength: 1, maxLength: 500 },
           action: { type: "string", enum: ["retry_same_phase", "reload_and_retry_phase", "reopen_editor_and_retry_phase", "wait_for_user"] },
           expectedEvidence: { type: "string", minLength: 1, maxLength: 300 },
           userInstruction: { type: "string", minLength: 1, maxLength: 500 },
         },
       },
     },
   };
   ```
2. 写本地 zod schema `advisorOutcomeSchema = z.object({...}).strict()`，覆盖以上字段（含 userInstruction optional）。
3. `diagnoseAutomationFailure(input: AdvisorRequest): Promise<AdvisorOutcome>`：
   - 检查 `this.config.apiKey`（空 → `provider_not_configured`）；
   - 复用 `this.client(replyTimeout())`；
   - system prompt 简短（独立文本块）：
     ```
     你是 VBK Desktop 自动录入的诊断器。当前阶段在执行 Playwright 自动化时出错，请根据下面提供的 evidence 选择最合适的恢复动作。
     硬约束：只返回一个 action，绝不返回 patch / patch 路径 / 代码 / CSS 选择器 / URL / 浏览器脚本 / 提交审核或发布指令，禁止修改库存或价格，绝不在 rootCause 里编造未观察事实。若信息不足以行动直接返回 wait_for_user。
     ```
   - user prompt 用固定模板，只暴露 Global Constraint 第 3 条里允许的字段（`phase`、`attempt`、`error`、`productIdExists`、`basicInfoSaved`、`completedPhases`、`diagnosisHistory`）。
   - 调用 `client.chat.completions.create`，`max_completion_tokens: 1024`，`tools: [diagnosisTool]`，`tool_choice: { type: 'function', function: { name: 'submit_failure_diagnosis' } }`，`thinking: { type: 'disabled' }`，沿用 `service_tier`。
   - 解析：拿 `tool_calls[0].function.arguments`，用 `advisorOutcomeSchema.strict().safeParse`；不通过 → 抛 `invalid_model_output`（`console.warn` 仅记录 `phase`/`attempt`/`errorCode`，不写 raw payload）；通过 → 直接返回。
   - 若 `action === 'wait_for_user'` 且 `userInstruction` 缺失/空 → 视为 schema 失败抛 `invalid_model_output`。
   - provider 错误用既有 `throwProviderError`。

- [ ] **Step 4: 跑测试验证全过**

Run: `npm test -- test/minimax.test.ts`
Expected: 全部 PASS（包含新增的 6 条 + 原有）。

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 与改造前同 PASS 数（264 + 新增 6）。

- [ ] **Step 6: commit**

```bash
git add src/main/minimax.ts src/shared/contracts.ts test/minimax.test.ts test/automation-recovery.test.ts
git commit -m "feat(minimax): diagnosis 流，支持受限自修正"
```

---

## Task 3: 实现 recovery runner

**Files:**
- Create: `src/main/automation/recovery.ts`
- Modify: `src/main/automation/phase-retry.ts` 暂不改；保持它作为"重试按阶段"旧入口行为不变。
- Test: `test/automation-recovery.test.ts`

**Interfaces:**
- Consumes: `AdvisorRequest`、`AdvisorOutcome`、`PhaseRecovery`、`AutomationRun`。
- Produces: 单一 `runPhaseWithRecovery`，签名严格：

```ts
export interface RecoveryContext {
  /** 当前 automation run，会被 in-place 更新 recovery 字段。 */
  run: AutomationRun;
  /** 当前阶段名。 */
  phase: string;
  /** 已完成阶段列表，用于上下文。 */
  completedPhases: string[];
  /** productId 是否存在，用于 reload/reopen 决策。 */
  productIdExists: boolean;
  /** basicInfoSaved，用于 advisor 上下文。 */
  basicInfoSaved: boolean;
  /** 实际执行该阶段的本地 handler；reload/reopen/retry 共用。 */
  execute: () => Promise<unknown>;
  /** advisor 闭包，由 DraftAutomation 注入。 */
  advisor: (req: AdvisorRequest) => Promise<AdvisorOutcome>;
  /** 把 advisor 提议的动作落到本地浏览器；返回新阶段结果。 */
  applyAction: (action: AdvisorAction, attempt: number) => Promise<void>;
  /** log helper；只追加 info/warning/error 字符串。 */
  log: (message: string, level?: "info" | "warning" | "error") => void;
  /** 持久化 AutomationRun 后通知 UI。 */
  persist: () => void;
  now?: () => Date;
}
export async function runPhaseWithRecovery(ctx: RecoveryContext): Promise<{ status: "completed" | "needs_user"; finalError?: string }>;
```

- [ ] **Step 1: 写失败测试**

`test/automation-recovery.test.ts` 主体。覆盖 Global Constraint 第 6/7/8 条所列至少 8 条用例：
1. 首次成功不调用 advisor；
2. 失败一次 → diagnosis → retry_same_phase 重新执行 handler 成功（`advisor.calls.length === 1`，`recovery.phases.basic.attempts.length === 1`，最终 `state === 'completed'`）；
3. reload_and_retry_phase：attempt=1 reload 一次 → handler 再执行成功，记录的 action = reload_and_retry_phase；
4. reopen_editor_and_retry_phase 且 `productIdExists=false` → 降级为 retry_same_phase（advisor 只发一次 reopen，但 `applyAction` 收到的是 `retry_same_phase`）；
5. wait_for_user 立即 stop：`recovery.phases[phase].state === 'needs_user'`，handler 不再被调用；
6. advisor 抛错（`advisor` 返回 rejected promise）→ 按 needs_user，`recovery.phases[phase].finalError` 含 `"MiniMax 诊断失败"`；
7. advisor 返回非法 shape（`action: 'something_else'`）→ 同上 needs_user；
8. attempt=3 后不再调 advisor：`attempts.length === 3`，最终 `state === 'needs_user'`，`applyAction` 不被调用，handler 不再被第 4 次执行。

示例第 1 条：
```ts
test("runPhaseWithRecovery: 首次成功不调用 advisor", async () => {
  const advisor = makeSpyAdvisor();
  const calls: string[] = [];
  const run: AutomationRun = { id: "r1", status: "running", phases: [], logs: [] };
  const result = await runPhaseWithRecovery({
    run, phase: "basic", completedPhases: [],
    productIdExists: false, basicInfoSaved: false,
    execute: async () => { calls.push("exec"); },
    advisor: advisor.fn,
    applyAction: async () => { calls.push("apply"); },
    log: () => undefined, persist: () => undefined,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["exec"]);
  assert.equal(advisor.fn.mock.calls.length, 0);
  assert.equal(run.recovery?.phases.basic?.state, "completed");
});
```

辅助 fixture `makeSpyAdvisor()`、`makeFakeExecute(...)`、可控失败次数的 `execute`，全部在文件顶部 helper 区写齐。

- [ ] **Step 2: 跑测试，应该全部失败**

Run: `npm test -- test/automation-recovery.test.ts`
Expected: 8 个新增 FAIL（找不到 `runPhaseWithRecovery`）。

- [ ] **Step 3: 实现 `src/main/automation/recovery.ts`**

要点：
- `MAX_PHASE_ATTEMPTS = 3` 常量 `export`。
- `runPhaseWithRecovery` 主循环伪码：
  ```
  run.recovery ??= { phases: {} };
  rec = run.recovery.phases[phase] ??= { phase, state: "running", attempts: [] };
  rec.state = "running";
  rec.attempts = []; rec.userInstruction = undefined; rec.finalError = undefined;
  persist();
  let lastError: unknown = undefined;
  for attempt from 1 to MAX_PHASE_ATTEMPTS:
      rec.state = "running";
      persist();
      try { await execute(); lastError = undefined; rec.state = "completed"; persist(); return { status: "completed" }; }
      catch (err):
          const e = stripSensitive(err);
          lastError = e;
          rec.attempts.push({ attempt, error: e.message, at: now().toISOString() });
          persist();
          if (attempt >= MAX_PHASE_ATTEMPTS) break;
          rec.state = "advising"; persist();
          let outcome;
          try { outcome = await advisor({...}); } catch { push userInstruction; break advising-failed branch; }
          if (!isAdvisorAction(outcome.action)) break invalid-shape branch;
          rec.attempts[last].diagnosis = { summary, rootCause, expectedEvidence };
          rec.attempts[last].action = outcome.action;
          if (outcome.action === "wait_for_user") { rec.userInstruction = outcome.userInstruction ?? "请在 VBK 手动确认后再次保存草稿。"; break wait-for-user branch; }
          // 降级 reopen→retry 如果没有 productId：
          let action = outcome.action;
          if (action === "reopen_editor_and_retry_phase" && !ctx.productIdExists) action = "retry_same_phase";
          rec.state = "retrying"; persist();
          await ctx.applyAction(action, attempt);
  // exit loop:
  rec.state = "needs_user";
  rec.finalError = lastError?.message ?? "MiniMax 诊断失败";
  if (!rec.userInstruction) rec.userInstruction = "请在 VBK 手动确认后再次保存草稿。";
  run.status = "blocked";
  persist();
  return { status: "needs_user", finalError: rec.finalError };
  ```
- `stripSensitive(err)`：剥掉 `/vbk.*\.com/i`、`/\d{11}/`、`/[\w-]+@[\w.-]+/`、`/select\(.+?\)/i`、`/await page\.[a-zA-Z]+/i` 等明显泄露，把错误消息限长到 280 字符。
- `isAdvisorAction(a)`: 枚举白名单 + userInstruction 必填（when action === wait_for_user）。
- 不在文件里 import minimax；advisor 是回调闭包，不读环境变量。
- `log()` 只追加 messages；不写 raw advisor payload。

- [ ] **Step 4: 跑测试**

Run: `npm test -- test/automation-recovery.test.ts`
Expected: 8 个新增 PASS。

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: PASS（仅新增）。

- [ ] **Step 6: commit**

```bash
git add src/main/automation/recovery.ts test/automation-recovery.test.ts
git commit -m "feat(automation): recovery runner，受 3 次上限"
```

---

## Task 4: DraftAutomation 接入 advisor + runner，绝不重建草稿

**Files:**
- Modify: `src/main/automation.ts`
- Test: 现有 test 行为**不**新增（runner 单测已经覆盖），只跑全量验证 204 不回归。

- [ ] **Step 1: 让构造函数接受 advisor**

```ts
import { runPhaseWithRecovery, type RecoveryContext } from "./automation/recovery.js";
...
export class DraftAutomation {
  private running = new Set<string>();
  constructor(
    private db: VbkDatabase,
    private browser: VbkBrowser,
    private onUpdate: (project: ProjectDetail) => void,
    private advisor: (req: AdvisorRequest) => Promise<AdvisorOutcome>,
  ) {}
  ...
}
```

- [ ] **Step 2: 重写 `run(projectId, retryFrom?)`**

关键改动：
1. 开局维持不变（productId 已存在 → `openProductEditor`；否则仅当 startIndex===0 才 `configureProductShell+createProductShell`）。**绝对不在 retry 路径里新建草稿。**
2. 把每个 phase handler 包成 `execute`，把 advisor 闭包包成 runner 需要的 ctx：
   ```ts
   const ctx: RecoveryContext = {
     run, phase: phaseKey, completedPhases: draftPhases.slice(0, index),
     productIdExists: Boolean(productId), basicInfoSaved: project.basicInfoSaved ?? false,
     execute: async () => handlers[phaseKey](),
     advisor: this.advisor,
     applyAction: async (action, attempt) => {
       if (action === "retry_same_phase") return;
       if (action === "reload_and_retry_phase") {
         await page.reload({ waitUntil: "domcontentloaded" });
         if (productId) await openProductEditor(page, productId);
         return;
       }
       if (action === "reopen_editor_and_retry_phase") {
         if (productId) await openProductEditor(page, productId);
         return;
       }
       // wait_for_user handled by runner; unreachable here
     },
     log, persist: () => { this.db.saveAutomation(projectId, run); this.emit(projectId); },
   };
   const outcome = await runPhaseWithRecovery(ctx);
   if (outcome.status === "needs_user") {
     run.status = "needs_user" as AutomationRun["status"]; run.status = "blocked" as AutomationRun["status"]; // 兼容既有 mapping
     run.currentPhase = phaseKey;
     this.db.saveAutomation(projectId, run); this.emit(projectId);
     this.db.updateProduct(projectId, project.product, "blocked");
     return; // 不再继续后续 phase
   }
   run.phases[phaseIndex].status = "completed";
   ```
3. **recovery status 写入**：每次 save 都带最新 `run.recovery`。TaskStatus 没有 `needs_user`，统一沿用 `"blocked"`（AutomationRun.status 是 `'failed'|'running'|'succeeded'|...| 'blocked'`，通过 `tasks` 映射时按 needs_user 显示）。其实 `run.status` 一律用 `"blocked"`；`recovery.phases[phase].state === 'needs_user'` 才是 UI 真值。
4. **basic 阶段也走 runner**：把当前的 `fillAndSaveBasicInfo` 包成 `execute`；attempt 计数与其它 phase 完全一致。basic 通过后 `db.setBasicInfoSaved(projectId)`。
5. **不调用**任何 `submit`/`publish`/`online`/`createProductShell` 当 attempt > 1：runner 里只允许 `page.reload + openProductEditor` + `fillAndSaveBasicInfo`/既有 handler。
6. **保留 phase retry 入口**：`retryPhase(projectId, phase)` 走原本 `preparePhaseRetry` + 新调 `runPhaseWithRecovery` 的 targeted 模式；这是给 UI 手动单阶段重试用，不算自动 attempt。

- [ ] **Step 3: 跑现有 204 测试 + 新增 runner 测试**

Run: `npm test`
Expected: PASS。

- [ ] **Step 4: 类型检查**

Run: `npm run check`
Expected: 0 错误。

- [ ] **Step 5: commit**

```bash
git add src/main/automation.ts
git commit -m "feat(automation): draft 阶段接入 recovery runner"
```

---

## Task 5: main.ts 构造 advisor 并注入 DraftAutomation

**Files:**
- Modify: `src/main/main.ts:172`

- [ ] **Step 1: 在 `createWindow` 内构造 advisor**

```ts
automation = new DraftAutomation(
  db,
  browser,
  emitProject,
  async (req) => {
    const settings = getSettings();
    const service = new MiniMaxService({ apiKey: apiKey(), baseUrl: settings.minimaxBaseUrl, model: settings.minimaxModel });
    try { return await service.diagnoseAutomationFailure(req); }
    catch (error) {
      console.warn("[recovery] advisor failed", { phase: req.phase, attempt: req.attempt, errorCode: (error as { code?: string }).code });
      // 让 runner 把 advisor 抛错当 needs_user 处理——把错误再次抛出。
      throw error;
    }
  },
);
```

注意：仅捕获并打 warning（不写 raw payload），再 rethrow，让 runner 自己按 needs_user 处理。不要在 main 里 fallback 默认 action。

- [ ] **Step 2: 跑类型检查 + 测试**

Run: `npm run check && npm test`
Expected: PASS。

- [ ] **Step 3: commit**

```bash
git add src/main/main.ts
git commit -m "feat(main): 注入 advisor 到 DraftAutomation"
```

---

## Task 6: UI 在"自动录入进度"区段显示 recovery 状态

**Files:**
- Modify: `src/renderer/App.tsx`（替换 `automation` section 的渲染，1014-1034 行附近）
- Modify: `src/renderer/styles.css`（最小新增，覆盖 `needs_user` / `advising` / `retrying` 三种状态的小卡片）

- [ ] **Step 1: 增加一个 selector 工具**

紧挨 `toDisplayStages`，新增：
```ts
function recoverySummary(run: ProjectDetail["automation"]) {
  if (!run || !run.recovery) return null;
  const block = Object.values(run.recovery.phases).find((rec) => rec.state === "needs_user");
  if (!block) return null;
  return { phase: block.phase, instruction: block.userInstruction || "请在 VBK 手动确认后再次保存草稿。", attempts: block.attempts };
}
function activeAdvisorHint(run: ProjectDetail["automation"]) {
  if (!run?.recovery) return null;
  for (const rec of Object.values(run.recovery.phases)) {
    if (rec.state === "advising") return { phase: rec.phase, currentAttempt: rec.attempts.length + 1 };
    if (rec.state === "retrying") return { phase: rec.phase, currentAttempt: rec.attempts.length };
  }
  return null;
}
```

- [ ] **Step 2: 修改 `automation` section 的 JSX**

```jsx
const recovery = project.automation ? recoverySummary(project.automation) : null;
const advisorHint = project.automation ? activeAdvisorHint(project.automation) : null;
```
替换原 `{/* 自动录入进度 */}` 块为：
```jsx
<div className="automation">
  <div className="automation-body">
    {toDisplayStages(project.automation!.phases).map(stage => (...))}
  </div>
  {advisorHint && (
    <div className="recovery-banner" data-state="advising" role="status">
      <LoaderCircle size={14} />
      <span>MiniMax 正在诊断阶段「{advisorHint.phase}」第 {advisorHint.currentAttempt} 次尝试…</span>
    </div>
  )}
  {recovery && (
    <div className="recovery-banner" data-state="needs_user" role="alert">
      <TriangleAlert size={14} />
      <div>
        <strong>已停止，等待用户处理：阶段 {recovery.phase}</strong>
        <p>{recovery.instruction}</p>
        <ol className="recovery-attempts">
          {recovery.attempts.map(attempt => (
            <li key={attempt.attempt}>
              <span>第 {attempt.attempt} 次</span>
              {attempt.diagnosis && <em>{attempt.diagnosis.rootCause}</em>}
              <code>{attempt.error}</code>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )}
  <p className="automation-note">系统只保存草稿，不会提交审核或发布。</p>
</div>
```

并把 "保存草稿" 按钮在 `recovery != null` 时把文案换成 "重新开始一轮保存"（语义不变，`onClick` 仍是 `startAutomation`）。

- [ ] **Step 3: 加最小样式**

在 styles.css 末尾追加：
```css
.recovery-banner { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); }
.recovery-banner[data-state='advising'] { border-color: rgba(8, 145, 178, 0.4); background: rgba(8, 145, 178, 0.06); }
.recovery-banner[data-state='needs_user'] { border-color: rgba(220, 38, 38, 0.4); background: rgba(220, 38, 38, 0.06); }
.recovery-banner strong { display: block; }
.recovery-attempts { margin: 8px 0 0; padding: 0; list-style: none; }
.recovery-attempts li { font-size: 12px; color: var(--muted-foreground); padding: 4px 0; border-bottom: 1px dashed var(--border); }
.recovery-attempts li em { font-style: normal; color: var(--foreground); display: block; }
.recovery-attempts li code { font-size: 11px; color: var(--muted-foreground); }
```

- [ ] **Step 4: 类型检查**

Run: `npm run check`
Expected: 0 错误。

- [ ] **Step 5: 视觉验证（在不打开真实 VBK 的情况下）**

因为不能动真实 UI（产品要求），我们只跑 build：
Run: `npm run build`
Expected: 0 错误（vite 会顺带提示无未使用变量）。

- [ ] **Step 6: commit**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(ui): 自动录入进度展示 MiniMax 诊断与停住"
```

---

## Task 7: README/DESIGN/PRODUCT 不动 + 防触碰无关文件

- [ ] **Step 1: 跑 `git diff --check` 确认无 trailing whitespace / no CRLF**

Run: `git diff --check`
Expected: 无输出。

- [ ] **Step 2: 跑全量验证**

Run: `npm test && npm run check`
Expected: PASS / 0 错误。

- [ ] **Step 3: 列改动给用户**

```bash
git diff --stat origin/main
```

仅应包含：
```
src/main/minimax.ts
src/main/automation.ts
src/main/automation/recovery.ts   (+ new)
src/main/main.ts
src/shared/contracts.ts
src/renderer/App.tsx
src/renderer/styles.css
test/minimax.test.ts
test/automation-recovery.test.ts   (+ new)
```
其它 "M" dirty 文件（database.ts、ctrip.ts、preload.cts、vehicle-resource.ts、product-normalize.ts、product-patch.ts、其它 test/\*）应当 0 改动。如果 `git diff --stat` 显示额外文件被触碰，必须回滚。

---

## Self-Review

1. **Spec coverage**：
   - §1 schema 白名单 + 严格 zod → Task 2 step 3。
   - §2 prompt 不变量 → Task 2 system/user 模板已枚举字段。
   - §3 不发敏感数据 → Task 2 AdvisorRequest 不含 product JSON/DOM/key。
   - §3 不污染 patch → diagnoseAutomationFailure 不动 patch 协议；新增 tool `submit_failure_diagnosis`。
   - §3 日志零 raw → Task 2 step 6 测试断言。
   - §4 advisor 注入 + automation.ts 不读 key → Task 4 + Task 5。
   - §5 MAX=3 + 四类 action 映射 → Task 3。
   - §6 basic 走 runner + tab 解锁门禁保留 → Task 4 step 2。
   - §7 advisor 失败等价 wait_for_user → Task 3 step 3 伪码分支。
   - §8 AutomationRun recovery + UI 展示 → Task 1 + Task 6。
   - §9 真实 blocker：basic 失败按上述 runner 重试 → 现有 fillAndSaveBasicInfo 不变，handler 调用相同。
   - §10 不改发布/库存 → Task 4 only open existing editor + reload + fillAndSaveBasicInfo。

2. **Placeholder scan**：本计划无 TBD / "implement later"。所有代码块都是可粘贴片段。

3. **Type consistency**：`AdvisorAction` / `PhaseRecovery` / `RecoveryState` / `PhaseAttempt` / `AutomationRun.recovery` 在 Task 1 定义并在后续 Task 引用同一份名字。

---

## Acceptance Criteria / 验收

- `npm test` → 全部 PASS（含新增 14 条 advisor/runner 用例，且现有 250+ 用例无回归）。
- `npm run check` → 0 类型错误（main + renderer 两套 tsconfig）。
- `npm run build` → 0 错误。
- `git diff --check` → 无输出。
- 改动文件列表严格匹配 Task 7 step 3 列出的 9 个文件（含 2 个新增）。
- 行为：basic 阶段失败 → 调用 advisor → runner 重试；advisor 抛错或返回非白名单 action → needs_user + UI 显示；attempt=3 强制停。
