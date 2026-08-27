// @ts-nocheck
/**
 * 「基本信息」tab 阶段入口：fillAndSaveBasicInfo。
 *   - 先 dismissKnownNoticeDialogs 吃掉轻量提示；
 *   - 点「产品信息 / 基本信息」tab；
 *   - 调用 core.fillBasicInfo 完成所有字段写入与管家选择；
 *   - saveThenAdvance 推进到「产品图文」tab，并在前后各跑一次
 *     assertBasicInfoNoRedErrors 校验页面没有红色错误提示。
 * 顶部带 `// @ts-nocheck`，page 是动态传入。
 */

import { clickSection, saveThenAdvance } from "../tabs.js";
import { dismissKnownNoticeDialogs } from "../dialogs.js";
import { fillBasicInfo, assertBasicInfoNoRedErrors } from "./core.js";
import { isProductImageTextUrl } from "../tabs.js";

/**
 * 基本信息面板保存主入口，返回 saveThenAdvance 的 { advanced, mode, savedWith }。
 * 任一阶段报错会让上层 stage-runner 走 advisor 兜底。
 */
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
