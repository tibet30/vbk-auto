/**
 * 操作日志的内存数据源。
 *
 * 真实数据最终会来自自动化运行期写入的持久化文件 / 主进程缓存；本文件
 * 只在开发期提供一份稳定可复现的样例，方便先把页面 UI 打磨好之后再
 * 切换到真实数据流。
 */

import type {
  OperationLogEntry,
  OperationLogPage,
  OperationLogQuery,
  OperationLogSummary,
  OperationStatus,
} from "../../shared/contracts.js";

const NOW = Date.now();

/**
 * 返回距 NOW 之前 ms 毫秒的 ISO 时间字符串——样例数据相对当前时刻对齐，
 * 让 UI 时间戳相对值（"刚刚 / 3 分钟前"）看起来合理。
 */
function ago(ms: number) {
  return new Date(NOW - ms).toISOString();
}

/**
 * 18 条样例：覆盖四种状态与多种类型，让统计卡 / 过滤栏 / 空状态 /
 * 加载态都能立刻被验证。其中 1 条 running 用于在头部表达"还在跑"。
 */
const SAMPLE_ENTRIES: OperationLogEntry[] = [
  {
    id: "op-018",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "click",
    name: "点击「确认删除」",
    status: "failed",
    stage: "basicInfo",
    phase: "supplier",
    attempt: 3,
    startedAt: ago(2 * 60_000),
    durationMs: 820,
    target: ".ant-popover .ant-btn-primary",
    message: "ElementClickIntercepted: element click intercepted: other element would receive the click",
  },
  {
    id: "op-017",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "verify",
    name: "校验供应商编码回填",
    status: "failed",
    stage: "basicInfo",
    phase: "supplier",
    attempt: 3,
    startedAt: ago(3 * 60_000),
    durationMs: 410,
    target: "input[name='supplierProductCode']",
    message: "断言失败：期望 SUP-2024-TY-0001，实际为空字符串。",
  },
  {
    id: "op-016",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "navigate",
    name: "跳转至销售控制页",
    status: "succeeded",
    stage: "saleControl",
    attempt: 1,
    startedAt: ago(9 * 60_000),
    durationMs: 1240,
    target: "/ivbk/vendor/saleControlMerge?productId=…",
  },
  {
    id: "op-015",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "input",
    name: "填写产品副标题",
    status: "failed",
    stage: "basicInfo",
    phase: "subtitle",
    attempt: 2,
    startedAt: ago(11 * 60_000),
    durationMs: 320,
    target: "textarea[name='subtitle']",
    message: "element not interactable: textarea 处于 disabled 状态，需要先勾选「启用副标题」。",
  },
  {
    id: "op-014",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "click",
    name: "勾选「启用副标题」",
    status: "succeeded",
    stage: "basicInfo",
    phase: "subtitle",
    attempt: 1,
    startedAt: ago(12 * 60_000),
    durationMs: 240,
    target: ".ant-checkbox-input",
  },
  {
    id: "op-013",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "screenshot",
    name: "保存基本信息的现场截图",
    status: "succeeded",
    stage: "basicInfo",
    attempt: 1,
    startedAt: ago(13 * 60_000),
    durationMs: 360,
  },
  {
    id: "op-012",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "select",
    name: "选择目的地「太原」",
    status: "succeeded",
    stage: "basicInfo",
    phase: "destination",
    attempt: 1,
    startedAt: ago(15 * 60_000),
    durationMs: 580,
    target: ".ant-select[aria-label='destination']",
  },
  {
    id: "op-011",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "wait",
    name: "等待产品列表懒加载",
    status: "succeeded",
    stage: "basicInfo",
    attempt: 1,
    startedAt: ago(16 * 60_000),
    durationMs: 720,
  },
  {
    id: "op-010",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "navigate",
    name: "打开产品列表",
    status: "succeeded",
    stage: "basicInfo",
    attempt: 1,
    startedAt: ago(17 * 60_000),
    durationMs: 1450,
    target: "/ivbk/vendor/productListMerge",
  },
  {
    id: "op-009",
    projectId: "p-xian",
    projectName: "西安 2 天 1 晚跟团游",
    type: "verify",
    name: "校验行程天数",
    status: "skipped",
    stage: "itinerary",
    phase: "days",
    attempt: 1,
    startedAt: ago(34 * 60_000),
    durationMs: 120,
    message: "运营已手工跳过此步，留待产品上线后补检。",
  },
  {
    id: "op-008",
    projectId: "p-xian",
    projectName: "西安 2 天 1 晚跟团游",
    type: "click",
    name: "保存行程草稿",
    status: "succeeded",
    stage: "itinerary",
    attempt: 1,
    startedAt: ago(36 * 60_000),
    durationMs: 940,
    target: "button.save-draft",
  },
  {
    id: "op-007",
    projectId: "p-xian",
    projectName: "西安 2 天 1 晚跟团游",
    type: "upload",
    name: "上传封面图",
    status: "succeeded",
    stage: "presentation",
    attempt: 1,
    startedAt: ago(48 * 60_000),
    durationMs: 2360,
  },
  {
    id: "op-006",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "click",
    name: "选择「地接社：山西文旅」",
    status: "succeeded",
    stage: "basicInfo",
    phase: "supplier",
    attempt: 1,
    startedAt: ago(2 * 3600_000),
    durationMs: 480,
    target: ".ant-select-item[title='山西文旅']",
  },
  {
    id: "op-005",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "input",
    name: "填写供应商产品编码",
    status: "succeeded",
    stage: "basicInfo",
    phase: "supplier",
    attempt: 1,
    startedAt: ago(2 * 3600_000 + 12_000),
    durationMs: 380,
    target: "input[name='supplierProductCode']",
  },
  {
    id: "op-004",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "verify",
    name: "校验产品类型默认项",
    status: "succeeded",
    stage: "basicInfo",
    phase: "productType",
    attempt: 1,
    startedAt: ago(2 * 3600_000 + 30_000),
    durationMs: 140,
  },
  {
    id: "op-003",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "navigate",
    name: "进入 basicInfo 阶段",
    status: "succeeded",
    stage: "basicInfo",
    attempt: 1,
    startedAt: ago(2 * 3600_000 + 60_000),
    durationMs: 1120,
  },
  {
    id: "op-002",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "screenshot",
    name: "登录后页面快照",
    status: "succeeded",
    attempt: 1,
    startedAt: ago(2 * 3600_000 + 90_000),
    durationMs: 420,
  },
  {
    id: "op-001",
    projectId: "p-taiyuan",
    projectName: "太原 3 天 2 晚私家团",
    type: "verify",
    name: "检测 VBK 登录态",
    status: "running",
    attempt: 1,
    startedAt: ago(0),
    durationMs: 0,
    message: "等待登录后导航完成…",
  },
];

/**
 * 按 status 统计 succeeded/failed/skipped/running 各自数量，得到 OperationLogSummary；
 * 用于头部卡片展示和过滤栏。
 */
function summarize(entries: OperationLogEntry[]): OperationLogSummary {
  const summary: OperationLogSummary = { total: entries.length, succeeded: 0, failed: 0, skipped: 0, running: 0 };
  for (const entry of entries) {
    if (entry.status === "succeeded") summary.succeeded += 1;
    else if (entry.status === "failed") summary.failed += 1;
    else if (entry.status === "skipped") summary.skipped += 1;
    else if (entry.status === "running") summary.running += 1;
  }
  return summary;
}

/**
 * 判断 entry 是否满足 query 的过滤条件（status / type / stage / projectId / 文本搜索）。
 * status / type / stage 传 "all" 时忽略该项；文本字段做去前后空格 + lowercase 后的 substring 匹配。
 */
function matchQuery(entry: OperationLogEntry, query: OperationLogQuery): boolean {
  if (query.status && query.status !== "all" && entry.status !== query.status) return false;
  if (query.type && query.type !== "all" && entry.type !== query.type) return false;
  if (query.stage && query.stage !== "all" && entry.stage !== query.stage) return false;
  if (query.projectId && entry.projectId !== query.projectId) return false;
  if (query.query) {
    const needle = query.query.trim().toLowerCase();
    if (!needle) return true;
    const haystack = [entry.name, entry.target, entry.message, entry.stage, entry.phase, entry.projectName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/**
 * 加载操作日志：按 query 过滤样例数据，按 startedAt 倒序，再做 summary + 阶段列表汇总；
 * 同时回填 refreshedAt 给 UI 展示"截至时间"。
 */
export function loadOperationLog(query: OperationLogQuery = {}): OperationLogPage {
  const entries = SAMPLE_ENTRIES.filter((entry) => matchQuery(entry, query))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const stages = Array.from(new Set(SAMPLE_ENTRIES.map((entry) => entry.stage).filter(Boolean))) as string[];
  return {
    summary: summarize(SAMPLE_ENTRIES),
    entries,
    stages,
    refreshedAt: new Date().toISOString(),
  };
}

/**
 * 返回状态过滤栏的可选值与中文标签（all / failed / succeeded / skipped / running）。
 */
export function listOperationStatusOptions(): Array<{ value: OperationStatus | "all"; label: string }> {
  return [
    { value: "all", label: "全部状态" },
    { value: "failed", label: "失败" },
    { value: "succeeded", label: "成功" },
    { value: "skipped", label: "跳过" },
    { value: "running", label: "进行中" },
  ];
}
