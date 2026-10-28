import test from "node:test";
import assert from "node:assert/strict";

import { trafficLineSkippedChildCanBeRevalidated } from "../../src/main/automation/ctrip/traffic-line/orchestrator.ts";
import {
  isUnavailableTrafficResourceFailure,
  trafficLinePendingSubmitNeedsOneRecoveryRetry,
  trafficLineChildShouldBeSkipped,
  trafficLineSkippedChildCanBeRetried,
  trainEndpointNeedsReplacement,
} from "../../src/main/automation/ctrip/traffic-line/main.ts";
import { trafficLineFailureProgress } from "../../src/main/automation/ctrip/traffic-line/child-failure.ts";

test("只有正式资源零城市失败才允许替换已持久化火车站", () => {
  const base = {
    variant: "trainRoundTrip" as const,
    lineDescription: "火车往返",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"] as const,
    verified: false,
    failedStage: "resourcesSaved" as const,
  };
  assert.equal(trainEndpointNeedsReplacement([{ ...base, failureReason: "子产品资源回读缺少多出发城市，不能激活套餐。" }]), true);
  assert.equal(trainEndpointNeedsReplacement([{ ...base, failedStage: undefined, failureReason: "子产品资源校验后没有任何可用的多出发城市（站点：西安/西安），未激活套餐。" }]), true);
  assert.equal(trainEndpointNeedsReplacement([{ ...base, failureReason: "当前用户未登录" }]), false);
  assert.equal(trainEndpointNeedsReplacement([{ ...base, failedStage: "itinerarySaved", failureReason: "缺少多出发城市" }]), false);
});

test("平台明确无可售资源时默认跳过；已创建的资源零城市子产品允许受控恢复", () => {
  const reason = "子产品资源校验后没有任何可用的多出发城市（站点：日喀则/日喀则），未激活套餐。";
  assert.equal(isUnavailableTrafficResourceFailure(reason), true);
  assert.equal(isUnavailableTrafficResourceFailure("浏览器请求超时"), false);
  assert.equal(trafficLineChildShouldBeSkipped({
    variant: "trainRoundTrip",
    lineDescription: "火车往返",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"],
    verified: false,
    failedStage: "resourcesSaved",
    failureReason: reason,
  }), true);
  assert.equal(trafficLineSkippedChildCanBeRetried({
    variant: "trainRoundTrip",
    lineDescription: "火车往返",
    childProductId: "78305132",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"],
    verified: false,
    skipped: true,
    failureReason: reason,
  }), true);
  assert.equal(trafficLineSkippedChildCanBeRetried({
    variant: "trainRoundTrip",
    lineDescription: "火车往返",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"],
    verified: false,
    skipped: true,
    failureReason: reason,
  }), false);
  const packageFailure = "设置火车往返子产品套餐有效失败（Ack=Failure）：产品ID：78199134 出发城市为空,不能打包。";
  assert.equal(isUnavailableTrafficResourceFailure(packageFailure, "trainRoundTrip"), true);
  assert.equal(isUnavailableTrafficResourceFailure(packageFailure, "flightRoundTrip"), false);
  const trainClauseFailure = "子产品资源回读尚未生成火车去返程条款，未保存条款，可安全重试。";
  assert.equal(isUnavailableTrafficResourceFailure(trainClauseFailure, "trainRoundTrip"), false);
  assert.equal(isUnavailableTrafficResourceFailure(trainClauseFailure, "flightRoundTrip"), false);
  assert.equal(isUnavailableTrafficResourceFailure("火车票条款未分别生成去程与返程条款，可安全重试。", "trainRoundTrip"), false);
  assert.equal(isUnavailableTrafficResourceFailure("本班期没有可用交通资源", "trainRoundTrip"), true);
  const inventoryMissing = "产品没有可用于交通资源核验的销售班期，已保留交通子产品基础信息，跳过班期资源设置。";
  assert.equal(isUnavailableTrafficResourceFailure(inventoryMissing), false);
  const inventoryProgress = trafficLineFailureProgress({ variant: "trainRoundTrip", lineDescription: "火车往返",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"], verified: false }, inventoryMissing);
  assert.equal(inventoryProgress.skipped, true);
  assert.equal(inventoryProgress.skipReason, "local_inventory_missing");
  assert.equal(inventoryProgress.failedStage, "resourcesSaved");
  assert.equal(trafficLineChildShouldBeSkipped({
    variant: "trainRoundTrip",
    lineDescription: "火车往返",
    completedStages: ["planned", "childCreated", "clausesSaved"],
    verified: false,
    failedStage: "activated",
    failureReason: packageFailure,
  }), true);
});

test("当前会话重新确认可用时不沿用历史 skipped 失败，并保留当前计划外方式", () => {
  const failed = {
    variant: "flightRoundTrip" as const,
    lineDescription: "飞机往返",
    childProductId: "79194665",
    completedStages: ["planned", "stationsResolved", "childCreated"] as const,
    verified: false,
    skipped: true,
    failureReason: "子产品最终正式条款回读缺少：32269。",
  };
  assert.equal(trafficLineSkippedChildCanBeRevalidated(failed, {
    enabled: true,
    variants: ["flightRoundTrip"],
    availability: {
      endpointPlan: { arrivalCity: "成都", departureCity: "成都", resolvedAt: "2026-10-01T00:00:00.000Z" },
      availableVariants: ["flightRoundTrip"],
      unavailableVariants: {},
    },
  }), true);
  assert.equal(trafficLineSkippedChildCanBeRevalidated({ ...failed, variant: "trainRoundTrip", lineDescription: "火车往返" }, {
    enabled: true,
    variants: ["flightRoundTrip"],
    availability: {
      endpointPlan: { arrivalCity: "成都", departureCity: "成都", resolvedAt: "2026-10-01T00:00:00.000Z" },
      availableVariants: ["flightRoundTrip"],
      unavailableVariants: {},
    },
  }), false);
  assert.equal(trafficLineSkippedChildCanBeRevalidated(failed, {
    enabled: true,
    variants: ["flightRoundTrip"],
    availability: {
      endpointPlan: { arrivalCity: "成都", departureCity: "成都", resolvedAt: "2026-10-01T00:00:00.000Z" },
      availableVariants: [],
      unavailableVariants: { flightRoundTrip: "当前会话未确认可用" },
    },
  }), false);
});

test("持续 pending 的班期校验仅允许在超时后受控重提一次", () => {
  const progress = {
    variant: "flightRoundTrip" as const,
    lineDescription: "飞机往返",
    completedStages: ["planned", "stationsResolved", "childCreated", "presentationCopied"] as const,
    verified: false,
    failedStage: "resourcesSaved" as const,
    validationScheduleCount: 3,
    validationDepartureCityCount: 57,
    validationSubmittedAt: "2026-09-12T04:00:00.000Z",
  };
  assert.equal(trafficLinePendingSubmitNeedsOneRecoveryRetry(progress, new Date("2026-09-12T04:09:59.999Z")), false);
  assert.equal(trafficLinePendingSubmitNeedsOneRecoveryRetry(progress, new Date("2026-09-12T04:10:00.000Z")), true);
  assert.equal(trafficLinePendingSubmitNeedsOneRecoveryRetry({
    ...progress,
    validationRecoveryResubmittedAt: "2026-09-12T04:10:00.000Z",
  }, new Date("2026-09-12T05:00:00.000Z")), false);
  assert.equal(trafficLinePendingSubmitNeedsOneRecoveryRetry({
    ...progress,
    validationScheduleCount: undefined,
    validationSubmittedAt: undefined,
  }, new Date("2026-09-12T04:00:00.000Z")), true);
});
