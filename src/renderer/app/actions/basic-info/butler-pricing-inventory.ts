/**
 * 管家联系人 + 价格三件套 + 库存字段：
 *   - saveButler：selection 来自 AccountFixedInfo 的 butlerName（合法 ContactCardSelection）；
 *   - savePricing：写 adult / child / minimumTravelers，三件套同一笔互锁；
 *   - saveInventory：写 startDate / endDate / dailyQuota。
 *
 * 严禁编造：butler 必须来自 AccountFixedInfo；不允许 UI 自由输入资源组 ID。
 */

import type { ContactCardSelection } from "../../../../shared/contracts.js";
import type { UpdateFieldDeps } from "./update-field.js";
import { makeUpdateField } from "./update-field.js";

export function makeSaveButler(deps: UpdateFieldDeps) {
  const updateField = makeUpdateField(deps);
  return function saveButler(localProductId: string, selection: ContactCardSelection | null) {
    void updateField(localProductId, "butler", { field: "butlerContact", selection });
  };
}

/**
 * 写成人价 / 儿童价 / 起订人数；三者必同存，沿用 pricing 字段。
 *  - 不接受默认起订人数；UI 层 parsePricingDraft 已保证 minimumTravelers
 *    是用户输入的正整数，action 不再额外填补。
 *  - 不修改 commercial.pricing.cost（成本子对象），applyManualReviewField
 *    会保留已存在的 cost 字段。
 *  - 起订人数独立的 saving 锁与文案条目，便于 UI 在重渲染时只显示对应
 *    字段的 loading / error，不互相覆盖。
 */
export function makeSavePricing(deps: UpdateFieldDeps) {
  const { savingFieldsRef, basicInfoSaving } = deps;
  const updateField = makeUpdateField(deps);
  return function savePricing(localProductId: string, adult: number, child: number, minimumTravelers: number) {
    // 三字段同一笔保存互锁：只要任一字段正在 saving，整笔就拒，避免
    // 「保存 a 后立即编辑 b」产生半成品 pricing。锁粒度沿用「adult」作为
    // canonical slot（最与 schema pricing.adult 对齐），其它字段用
    // `basicInfoSaving === "adult"` 协同判断。
    if (savingFieldsRef.current.has("adult")
      || savingFieldsRef.current.has("minimumTravelers")
      || basicInfoSaving === "adult"
      || basicInfoSaving === "minimumTravelers") return;
    void updateField(localProductId, "adult", { field: "pricing", adult, child, minimumTravelers });
  };
}

export function makeSaveInventory(deps: UpdateFieldDeps) {
  const { savingFieldsRef, basicInfoSaving } = deps;
  const updateField = makeUpdateField(deps);
  return function saveInventory(localProductId: string, startDate: string, endDate: string, dailyQuota: number) {
    if (savingFieldsRef.current.has("inventory") || basicInfoSaving === "inventory") return;
    void updateField(localProductId, "inventory", { field: "inventory", startDate, endDate, dailyQuota });
  };
}