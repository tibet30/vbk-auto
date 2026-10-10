/**
 * helpers/components.tsx 通用 UI 元件（barrel）：
 *   - WorkbenchModule：三态卡片壳（ready / todo / emphasis）；
 *   - ProductList / ProductRow / productMeta：产品列表 + 行；
 *   - EmptyProductState：产品列表空态（按 aiConfigured 切换文案）；
 *   - CopyableId：可复制 ID 徽章；
 *   - Field：label + value 行内展示；
 *   - ShieldCheck：内联 SVG 盾牌 + 勾号图标；
 *   - issueGuidance / formatIssueGuidance / technicalDetailPattern：
 *     把后端技术校验文本映射为运营提示；
 *   - ProductBriefForm：re-export 自 ./product-brief-form。
 *
 * 子文件分工：
 *   - workbench.tsx：WorkbenchModule；
 *   - product-list.tsx：ProductList + ProductRow + productMeta；
 *   - empty-state.tsx：EmptyProductState；
 *   - copyable-id.tsx：CopyableId；
 *   - field.tsx：Field；
 *   - shield-check.tsx：ShieldCheck；
 *   - issue-guidance.tsx：issueGuidance + formatIssueGuidance + technicalDetailPattern。
 */

export { WorkbenchModule } from "./components/workbench.js";
export { ProductList } from "./components/product-list.js";
export { EmptyProductState } from "./components/empty-state.js";
export { CopyableId } from "./components/copyable-id.js";
export { Field } from "./components/field.js";
export { ShieldCheck } from "./components/shield-check.js";
export {
  issueGuidance,
  technicalDetailPattern,
  formatIssueGuidance,
} from "./components/issue-guidance.js";
export { ProductBriefForm } from "./product-brief-form.js";