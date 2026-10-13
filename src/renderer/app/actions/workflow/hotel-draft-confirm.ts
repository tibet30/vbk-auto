import type { HotelDraftRetryPlan } from "../../../../shared/hotel-draft-retry.js";
import { closeModalAboveVbk, showModalAboveVbk } from "../../helpers/vbk-modal-visibility";
import shared from "../../views/shared.module.less";
import styles from "../../views/workspace/planning-rerun-confirm-dialog.module.less";

/** HTML dialog leaves Electron's main event loop responsive during confirmation. */
export function confirmHotelDraftRetry(plan: HotelDraftRetryPlan): Promise<boolean> {
  return new Promise(resolve => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = document.createElement("dialog");
    dialog.className = styles.dialog;
    dialog.setAttribute("aria-modal", "true");
    const panel = document.createElement("div"); panel.className = styles.panel;
    const content = document.createElement("div"); content.className = styles.content;
    const title = document.createElement("h2"); title.id = "hotel-draft-confirm-title"; title.textContent = "仅保存酒店规则草稿";
    dialog.setAttribute("aria-labelledby", title.id);
    const description = document.createElement("p"); description.className = styles.description;
    description.textContent = `产品 ${plan.productId} · 账号 ${plan.accountKey} · ${plan.stays.map(stay => `${stay.cityName}${stay.nights}晚`).join("、") || "无住宿日"}`;
    const rules = document.createElement("p"); rules.className = styles.description;
    rules.textContent = "自动匹配：是；等级：三钻、四钻、五钻；指定酒店：空。";
    const scope = document.createElement("p"); scope.className = styles.retained;
    scope.textContent = "清除旧酒店要求与候选。本次只保存酒店草稿，不执行其他阶段、不提交审核、不发布。";
    content.append(title, description, rules, scope);
    const actions = document.createElement("div"); actions.className = styles.actions;
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = `${shared.btn} ${shared.btnSm}`; cancel.textContent = "取消";
    const confirm = document.createElement("button"); confirm.type = "button"; confirm.className = `${shared.btn} ${shared.btnSm}`;
    confirm.dataset.variant = "primary"; confirm.textContent = "仅保存酒店草稿";
    let finished = false;
    const finish = (approved: boolean) => {
      if (finished) return;
      finished = true;
      closeModalAboveVbk(dialog); dialog.remove();
      window.removeEventListener("pagehide", dismiss);
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(approved);
    };
    const dismiss = () => finish(false);
    cancel.addEventListener("click", dismiss);
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("close", dismiss);
    window.addEventListener("pagehide", dismiss, { once: true });
    actions.append(cancel, confirm); panel.append(content, actions); dialog.append(panel);
    document.body.append(dialog);
    void showModalAboveVbk(dialog, () => !finished).then(() => {
      if (!finished) cancel.focus();
    }).catch(dismiss);
  });
}
