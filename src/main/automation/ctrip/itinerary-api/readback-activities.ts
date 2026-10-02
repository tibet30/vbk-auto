import type { ReadbackExpectations } from "./itinerary-transform.js";

type ActivityPoi = { poi?: { poiId?: unknown; poiName?: unknown } };

type ActivityInfo = {
  activeType?: { key?: unknown; name?: unknown };
  description?: unknown;
  startOnBoardTime?: unknown;
  stopOnBoardTime?: unknown;
  takeoffTime?: { name?: unknown };
  takeTime?: unknown;
  tourDailyPois?: ActivityPoi[];
};

function activityKind(info: ActivityInfo): "free" | "other" | null {
  const key = String(info.activeType?.key ?? "");
  if (key === "7") return info.activeType?.name === "其他" ? null : "free";
  if (key === "9") return info.activeType?.name === "自由活动" ? null : "other";
  if (info.activeType?.name === "自由活动") return "free";
  if (info.activeType?.name === "其他") return "other";
  return null;
}

function isAttraction(info: ActivityInfo): boolean {
  return info.activeType?.key === 3 || info.activeType?.name === "景点";
}

function poiOf(poi: ActivityPoi | undefined) {
  return {
    poiId: Number(poi?.poi?.poiId ?? 0),
    poiName: String(poi?.poi?.poiName ?? "").trim(),
  };
}

/** 校验「其他 / 自由活动」节点 description、时段与服务时间。 */
export function checkReadbackActivities(
  dayLabel: string,
  expected: ReadbackExpectations["days"][number]["activities"],
  actualInfos: ActivityInfo[],
): void {
  if (expected.length === 0) return;
  const actual = actualInfos.flatMap((info) => {
    const kind = activityKind(info);
    return kind ? [{ info, kind }] : [];
  });
  if (actual.length !== expected.length) throw new Error(`${dayLabel} 回读自由活动/其他节点数不一致：期望 ${expected.length}，实际 ${actual.length}`);
  expected.forEach((entry, index) => {
    const node = actual[index];
    if (!node || node.kind !== entry.kind) throw new Error(`${dayLabel} 第 ${index + 1} 个业务卡片类型不一致：期望=${entry.kind}，实际=${node?.kind ?? "缺失"}`);
    const activityLabel = entry.kind === "other" ? "其他" : "自由活动";
    if (String(node.info.description ?? "").trim() !== entry.description) throw new Error(`${dayLabel} 回读「${activityLabel}」description 不一致：期望=${JSON.stringify(entry.description)}，实际=${JSON.stringify(String(node.info.description ?? "").trim())}`);
    if (String(node.info.takeoffTime?.name ?? "").trim() !== entry.time) throw new Error(`${dayLabel} 第 ${index + 1} 个${entry.kind}时段不一致`);
    if (entry.durationMinutes !== undefined && Number(node.info.takeTime) !== entry.durationMinutes) throw new Error(`${dayLabel} 第 ${index + 1} 个${entry.kind}时长不一致：期望=${entry.durationMinutes}，实际=${JSON.stringify(node.info.takeTime)}`);
    if (String(node.info.startOnBoardTime ?? "") !== "08:00") throw new Error(`${dayLabel} 回读服务时间 startOnBoardTime 不一致：期望=08:00，实际=${JSON.stringify(String(node.info.startOnBoardTime ?? ""))}`);
    if (String(node.info.stopOnBoardTime ?? "") !== "20:00") throw new Error(`${dayLabel} 回读服务时间 stopOnBoardTime 不一致：期望=20:00，实际=${JSON.stringify(String(node.info.stopOnBoardTime ?? ""))}`);
  });
}

/** 校验景点、自由活动和其他服务卡片的相对顺序。 */
export function checkReadbackTimeline(
  dayLabel: string,
  expected: ReadbackExpectations["days"][number]["timeline"],
  actualInfos: ActivityInfo[],
): void {
  if (expected.length === 0) return;
  const actual = actualInfos.filter((info) => isAttraction(info) || activityKind(info));
  if (actual.length !== expected.length) throw new Error(`${dayLabel} 业务卡片顺序回读数不一致：期望 ${expected.length}，实际 ${actual.length}`);
  expected.forEach((entry, index) => {
    const info = actual[index];
    if (entry.kind === "attraction") {
      if (!info || !isAttraction(info)) throw new Error(`${dayLabel} 第 ${index + 1} 个业务卡片应为景点，实际=${JSON.stringify(info?.activeType)}`);
      const pois = (info.tourDailyPois ?? []).map(poiOf);
      if (JSON.stringify(pois) !== JSON.stringify(entry.pois)) throw new Error(`${dayLabel} 第 ${index + 1} 个景点卡片 POI 顺序不一致：期望=${JSON.stringify(entry.pois)}，实际=${JSON.stringify(pois)}`);
      return;
    }
    const kind = info ? activityKind(info) : null;
    if (kind !== entry.kind) throw new Error(`${dayLabel} 第 ${index + 1} 个业务卡片类型不一致：期望=${entry.kind}，实际=${kind ?? "缺失"}`);
  });
}
