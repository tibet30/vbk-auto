// @ts-nocheck

import { clickSection, saveThenAdvance } from "../tabs.js";
import { dismissKnownNoticeDialogs } from "../dialogs.js";
import { fillBasicInfo, assertBasicInfoNoRedErrors } from "./core.js";
import { isProductImageTextUrl } from "../tabs.js";

export async function fillAndSaveBasicInfo(page, product, butlerSelection, extra = {}) {
  await dismissKnownNoticeDialogs(page);
  await clickSection(page, ["产品信息", "基本信息"]).catch(() => {});
  await fillBasicInfo(page, product, butlerSelection, extra);

  await assertBasicInfoNoRedErrors(page);

  const advanced = await saveThenAdvance(page, {
    phase: "基本信息",
    targetTabLabel: "产品图文/图文信息",
    saveButtonNames: ["保存", "保存并下一步"],
    targetTabLabels: ["产品图文", "图文信息"],
    isTargetUrl: isProductImageTextUrl,
  });

  await assertBasicInfoNoRedErrors(page);
  return advanced;
}

