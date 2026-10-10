import type { TrafficLineVariant, TrafficLineConfig, TrafficLineWorkflowProgress } from "./contracts-traffic-line.js";

/** 套餐启用的玩法线路审核前置条件，不是无交通资源，也不能靠重试写入解决。 */
export function isTrafficLineRouteReviewRequired(reason: string): boolean {
  return /未匹配玩法线路|提交审核匹配线路/u.test(reason);
}

export function isUnavailableTrafficResourceFailure(reason: string, variant?: TrafficLineVariant): boolean {
  if (/^当前无可售资源$/.test(reason)) return true;
  if (/没有可用于交通资源核验的销售班期/.test(reason)) return true;
  if (/(?:没有任何可用的多出发城市|未返回可用于(?:飞机|火车)往返的出发城市)/.test(reason)) return true;
  if (/(?:当前|本)班期.*(?:没有|无).*可用交通资源|(?:没有|无).*可用交通资源.*(?:当前|本)班期/.test(reason)) return true;
  // 同城接送的火车子产品能创建，但 VBK 到套餐有效化才返回该业务结论。
  // 这不是会话或协议失败；保留子产品记录并让其它交通方式继续完成。
  return variant === "trainRoundTrip" && (
    /出发城市为空\s*[,，]?\s*不能打包/.test(reason)
  );
}

/** 每个已启用的类型都必须有独立回读；缺失子产品不能被母草稿掩盖。 */
export function incompleteTrafficVariants(config: Partial<TrafficLineConfig> | undefined, progress: TrafficLineWorkflowProgress | undefined): TrafficLineVariant[] {
  if (!config?.enabled || !Array.isArray(config.variants)) return [];
  return config.variants.filter(variant => {
    const child = progress?.children.find(item => item.variant === variant);
    const reason = child?.failureReason ?? progress?.unavailableVariants?.[variant] ?? progress?.failureReason ?? "";
    if (isUnavailableTrafficResourceFailure(reason, variant)) return false;
    return !child?.verified || !child.completedStages.includes("finalReadback");
  });
}

/** Single projection for Agent gates, workflow copy and renderer status. */
export function trafficResourceStatus(config: Partial<TrafficLineConfig> | undefined, progress: TrafficLineWorkflowProgress | undefined) {
  const incompleteVariants = incompleteTrafficVariants(config, progress);
  const routeReviewChildren = (progress?.children ?? []).filter(child =>
    !child.verified && isTrafficLineRouteReviewRequired(child.failureReason ?? ""));
  return {
    incompleteVariants,
    routeReviewChildren,
    hasIncompleteTraffic: incompleteVariants.length > 0,
    requiresRouteReview: routeReviewChildren.length > 0,
  };
}
