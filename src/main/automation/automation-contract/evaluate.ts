/**
 * 评估产品对 VBK 录入契约的满足情况：
 *   - evaluateAutomationContract：扫一遍产品，返回缺/坏字段 + 阶段 + 人类可读提示；
 *     这是 readiness 阶段 + 自动化起跑前的「单一真实来源」。
 *   - failures：阻断性字段（ai-planning / account-fixed）缺/坏时填入；
 *   - runtimeExceptions：vbk-runtime / manual-only / ai-soft 失败时不计入 failures。
 *
 * 配套测试：test/automation/automation-contract.test.ts
 *   - G1: presentation.recommendations 缺失/坏/重复让 readiness 不通过；
 *   - G2: 一个合法 planning 输出的 presentation 会被契约视为就绪。
 */

import { readActiveCoverFallback } from "../../../shared/cover-fallback.js";
import type { VbkFieldContract } from "./fields.js";
import { VBK_PRODUCT_FIELDS } from "./fields.js";

export interface AutomationContractResult {
  failures: Array<{
    field: VbkFieldContract;
    /** 人类可读原因；用于 readiness issue / assert 错误文案。 */
    reason: string;
  }>;
  /** 仍可启动自动化，但运营 / 自动化阶段需要回填的字段清单。 */
  runtimeExceptions: Array<{
    field: VbkFieldContract;
    reason: string;
  }>;
  /** 整个产品契约是否通过（readiness = true）。 */
  ready: boolean;
}

/**
 * 评估产品对 VBK 录入契约的满足情况。
 * 这是 readiness 阶段 + 自动化起跑前的「单一真实来源」。
 */
export function evaluateAutomationContract(product: Record<string, unknown>): AutomationContractResult {
  const failures: AutomationContractResult["failures"] = [];
  const runtimeExceptions: AutomationContractResult["runtimeExceptions"] = [];
  for (const field of VBK_PRODUCT_FIELDS) {
    let ok = false;
    try {
      ok = field.check(product);
    } catch {
      ok = false;
    }
    if (ok) continue;
    if (field.path === "presentation.cover") {
      const fallback = readActiveCoverFallback(product);
      if (fallback) {
        failures.push({
          field,
          reason: "运营占位图只能录入未提审、未上架的草稿，请将发布控制设为 false。",
        });
        continue;
      }
    }
    if (field.source === "ai-planning" || field.source === "account-fixed") {
      failures.push({ field, reason: field.detail });
    } else {
      runtimeExceptions.push({ field, reason: `${field.label}由 ${field.source} 阶段回填：${field.detail}` });
    }
  }
  return { failures, runtimeExceptions, ready: failures.length === 0 };
}