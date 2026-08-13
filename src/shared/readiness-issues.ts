import type { ProductReadiness, ResearchTask } from "./contracts-types.js";

export type ReadinessIssue = ProductReadiness["issues"][number];

const vehiclePattern = /用车|车辆|接送|司机|vehicle|vehicleResource|resourceGroupId/i;
const hotelPattern = /酒店|住宿|客栈|民宿/;
const coverPattern = /封面|图片|产品图|image|cover/i;
const pricePattern = /成人价|儿童价|成人成本|儿童成本|价格|单房差|加床费|售价/;
const inventoryPattern = /库存|班期|每日配额|起订|起止日期/;

function normalizedText(value: string | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[：:，,。；;、/\\()[\]【】「」"'`]+/g, "");
}

export function openResearchTaskToIssue(task: Pick<ResearchTask, "label" | "detail">): ReadinessIssue {
  return { label: task.label, detail: task.detail || "需要在 VBK 或公开来源完成核查" };
}

export function readinessIssueSemanticKey(issue: Pick<ReadinessIssue, "label" | "detail">): string {
  const label = issue.label || "";
  const detail = issue.detail || "";
  const text = `${label} ${detail}`;
  if (vehiclePattern.test(text)) return "resource:vehicle";
  if (hotelPattern.test(text)) return "resource:hotel";
  if (coverPattern.test(text)) return "presentation:cover";
  if (pricePattern.test(text) && label !== "套餐与价格" && label !== "套餐名称") return "commercial:price";
  if (inventoryPattern.test(text)) return "commercial:inventory";
  return `exact:${normalizedText(label)}:${normalizedText(detail)}`;
}

function mergeDetail(left: string, right: string): string {
  const a = left.trim();
  const b = right.trim();
  if (!a) return b;
  if (!b || a === b || a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a}；${b}`;
}

function vehicleDetail(left: ReadinessIssue, right: ReadinessIssue): string {
  const candidates = [left.detail, right.detail].filter(Boolean);
  return candidates.find((detail) => /私家团.*VBK.*资源组|resourceGroupId/.test(detail))
    || candidates.sort((a, b) => b.length - a.length)[0]
    || "私家团需要在 VBK 核查并填写现有用车资源组 ID。";
}

function mergeIssue(left: ReadinessIssue, right: ReadinessIssue, key: string): ReadinessIssue {
  if (key === "resource:vehicle") {
    return { label: "用车资源组", detail: vehicleDetail(left, right) };
  }
  return { label: left.label || right.label, detail: mergeDetail(left.detail || "", right.detail || "") };
}

export function mergeReadinessIssues(issues: ReadonlyArray<ReadinessIssue>): ReadinessIssue[] {
  const merged = new Map<string, ReadinessIssue>();
  for (const issue of issues) {
    const key = readinessIssueSemanticKey(issue);
    const existing = merged.get(key);
    merged.set(key, existing ? mergeIssue(existing, issue, key) : issue);
  }
  return [...merged.values()];
}
