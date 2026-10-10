/**
 * sale-control 模块的拼小团链路（是否拼小团 / 是否参加广场拼团 / 最大拼团人数）：
 *   - setSmallGroupIfPresent：写入三档；
 *   - alternateSmallGroupInputValue：maxGroupSize 同值写不触发 React onChange 时
 *     先写相邻值再写回，确保表单真实更新。
 *   - readSmallGroupState / smallGroupStateMatches：核验远端状态是否已与目标匹配。
 *
 * 跟团游 / 半自助"是否拼小团"行 title 在不同页面有 4 种命名（是否拼小团 / 是否拆团 /
 * 是否独立成团 / 支持拆团），按出现顺序尝试；广场拼团与最大拼团人数各有 2 种。
 */

import type { VbkLocator, VbkPage } from "../../locator-types.js";
import { findRowByTitle } from "./row-locator.js";

export interface SmallGroupState {
  available: boolean;
  splitGroup?: boolean;
  squareGroup?: boolean;
  maxGroupSize?: number;
}

export async function setSmallGroupIfPresent(
  page: VbkPage,
  { wantSplit = true, joinSquareGroup = true, maxGroupSize = 8 }: {
    wantSplit?: boolean; joinSquareGroup?: boolean; maxGroupSize?: number;
  } = {},
) {
  const candidates = ["是否拼小团", "是否拆团", "是否独立成团", "支持拆团"];
  for (const label of candidates) {
    const row = findRowByTitle(page, label);
    const count = await row.count();
    if (!count) continue;
    const radio = row.getByRole("radio", { name: wantSplit ? "是" : "否", exact: true });
    const radioCount = await radio.count();
    if (radioCount >= 1) {
      await radio.first().check().catch(() => {});
      if (!(await radio.first().isChecked().catch(() => false))) return { row: label, skipped: "small-group-selection-not-confirmed" };
      if (!wantSplit) return { row: label, selected: "否" };

      const squareRows = ["是否参加广场拼团", "是否参加拼单广场"];
      let squareRow: VbkLocator | null = null;
      for (const squareLabel of squareRows) {
        const candidate = findRowByTitle(page, squareLabel);
        if (await candidate.count()) {
          squareRow = candidate;
          break;
        }
      }
      if (!squareRow) return { row: label, skipped: "square-group-row-not-found" };
      const squareRadio = squareRow.getByRole("radio", { name: joinSquareGroup ? "是" : "否", exact: true });
      if (!(await squareRadio.count())) return { row: label, skipped: "square-group-row-not-found" };
      await squareRadio.first().check().catch(() => {});
      if (!(await squareRadio.first().isChecked().catch(() => false))) return { row: label, skipped: "square-group-selection-not-confirmed" };

      const maxRows = ["最大拼团人数", "最大成团人数"];
      let maxInput: VbkLocator | null = null;
      for (const maxLabel of maxRows) {
        const candidate = findRowByTitle(page, maxLabel).locator("input").first();
        if (await candidate.count()) {
          maxInput = candidate;
          break;
        }
      }
      if (!maxInput) {
        return {
          row: label,
          selected: "是",
          squareGroup: joinSquareGroup ? "是" : "否",
          maxGroupSize: null,
          maxGroupSizeUnavailable: "platform-not-exposed",
        };
      }
      // Ant Design InputNumber 在初始展示值已经是目标值时，直接 fill 同值
      // 不会触发 React onChange，保存 DTO 仍可能保留服务端默认 0。先写入一个
      // 不同的合法值，再写回目标值，确保表单状态真实更新。
      const currentValue = (await maxInput.inputValue().catch(() => "")).trim();
      if (currentValue === String(maxGroupSize)) {
        await maxInput.fill(String(alternateSmallGroupInputValue(maxGroupSize)));
      }
      await maxInput.fill(String(maxGroupSize));
      await maxInput.press("Tab").catch(() => {});
      if ((await maxInput.inputValue().catch(() => "")).trim() !== String(maxGroupSize)) return { row: label, skipped: "max-group-size-not-confirmed" };
      return { row: label, selected: "是", squareGroup: joinSquareGroup ? "是" : "否", maxGroupSize };
    }
  }
  return { skipped: "split-group-row-not-found" };
}

export function alternateSmallGroupInputValue(maxGroupSize: number): number {
  return Number(maxGroupSize) === 1 ? 2 : Number(maxGroupSize) - 1;
}

export async function readSmallGroupState(page: VbkPage): Promise<SmallGroupState> {
  const splitLabels = ["是否拼小团", "是否拆团", "是否独立成团", "支持拆团"];
  let splitRow: VbkLocator | null = null;
  for (const label of splitLabels) {
    const candidate = findRowByTitle(page, label);
    if (await candidate.count()) {
      splitRow = candidate;
      break;
    }
  }
  if (!splitRow) return { available: false };

  const splitYes = splitRow.getByRole("radio", { name: "是", exact: true }).first();
  const squareLabels = ["是否参加广场拼团", "是否参加拼单广场"];
  let squareRow: VbkLocator | null = null;
  for (const label of squareLabels) {
    const candidate = findRowByTitle(page, label);
    if (await candidate.count()) {
      squareRow = candidate;
      break;
    }
  }
  const squareYes = squareRow?.getByRole("radio", { name: "是", exact: true }).first();
  const maxLabels = ["最大拼团人数", "最大成团人数"];
  let maxInput: VbkLocator | null = null;
  for (const label of maxLabels) {
    const candidate = findRowByTitle(page, label).locator("input").first();
    if (await candidate.count()) {
      maxInput = candidate;
      break;
    }
  }
  return {
    available: true,
    splitGroup: await splitYes.isChecked().catch(() => false),
    squareGroup: squareYes ? await squareYes.isChecked().catch(() => false) : false,
    maxGroupSize: maxInput ? Number(await maxInput.inputValue().catch(() => "")) : NaN,
  };
}

export function smallGroupStateMatches(state: SmallGroupState, maxGroupSize: number): boolean {
  return state?.available === true
    && state.splitGroup === true
    && state.squareGroup === true
    && Number(state.maxGroupSize) === Number(maxGroupSize);
}