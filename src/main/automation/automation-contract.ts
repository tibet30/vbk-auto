/**
 * 自动化「必填 VBK 字段」契约与早期 readiness gate（barrel）：
 *
 *   - VBK_PRODUCT_FIELDS：列出 VBK 录入每个阶段实际写入/读取的字段，
 *     每条含 path / label / phase / source / detail / check。
 *   - evaluateAutomationContract(product)：扫一遍产品，返回缺/坏字段
 *     + 阶段 + 人类可读提示；readiness / 自动化起跑前的单一真实来源。
 *   - assertPresentationReadyForVbk(product)：fillAndSavePresentation 内部
 *     防御闸门——即便 readiness 通过，VBK 写入前也再校验一次（defense in depth）。
 *
 * 「source」决定 readiness 行为：
 *   - "ai-planning"   ：规划阶段 AI 必须产出并写入；缺失/坏 → 阻断。
 *   - "ai-soft"       ：AI 写但不强制（缺则回退默认值）。
 *   - "account-fixed" ：从账号 AccountFixedInfo 读，main 端自动注入。
 *   - "vbk-runtime"   ：由 VBK 当前页下拉匹配在自动化阶段内回填；运营
 *                       核查可前置为 research task，但 readiness 不阻断。
 *   - "manual-only"   ：只能由人工 / 账号固定信息在运营面板写入。
 *
 * 配套测试：test/automation/automation-contract.test.ts
 *   - G1: presentation.recommendations 缺失/坏/重复让 readiness 不通过
 *         并明确告诉运营「恰好 3 条」；
 *   - G2: 一个合法 planning 输出的 presentation 会被契约视为就绪；
 *   - G3: assertPresentationReadyForVbk 会在 VBK 写入前就抛错；
 *   - G4: 列出每个 VBK 实际写入/读取的字段，验证要么被契约覆盖、
 *         要么是 vbk-runtime / manual-only / account-fixed exception。
 *
 * 子文件分工：
 *   - fields.ts：FieldSource / AutomationPhase / VbkFieldContract / VBK_PRODUCT_FIELDS；
 *   - evaluate.ts：evaluateAutomationContract / AutomationContractResult；
 *   - assert.ts：assertPresentationReadyForVbk；
 *   - location.ts：PRODUCT_JSON_LOCATION 文档化常量。
 */

export type { FieldSource, AutomationPhase, VbkFieldContract } from "./automation-contract/fields.js";
export { VBK_PRODUCT_FIELDS } from "./automation-contract/fields.js";
export type { AutomationContractResult } from "./automation-contract/evaluate.js";
export { evaluateAutomationContract } from "./automation-contract/evaluate.js";
export { assertPresentationReadyForVbk } from "./automation-contract/assert.js";
export { PRODUCT_JSON_LOCATION } from "./automation-contract/location.js";