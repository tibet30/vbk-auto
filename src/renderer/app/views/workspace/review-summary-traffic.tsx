import { BadgeCheck, ChevronDown, Plane, TrainFront } from "lucide-react";
import type { ProductDetail } from "../../../../shared/contracts-types.js";
import type { TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import styles from "./review-summary-traffic.module.less";

type UnknownRecord = Record<string, unknown>;

type TrafficReviewItem = {
  variant: TrafficLineVariant;
  arrival: string;
  departure: string;
  resourceState: "awaitingResource" | "checking" | "verified" | "unavailable" | "failed";
};

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function stationLabel(value: unknown, train = false): string | null {
  const station = record(value);
  if (!station) return null;
  const name = typeof station.name === "string" ? station.name.trim() : "";
  const code = typeof station.code === "string" ? station.code.trim() : "";
  if (!name) return null;
  const displayName = train && !name.endsWith("站") ? `${name}站` : name;
  return code ? `${displayName} · ${code}` : displayName;
}

/** 只读取受控端点接口结果；绝不从 AI 回复文本或行程景点猜测大交通。 */
function readTrafficReviewItems(product: ProductDetail): TrafficReviewItem[] {
  const root = record(product.product);
  const operations = record(root?.operations);
  const trafficLine = record(operations?.trafficLine);
  const availability = record(trafficLine?.availability) ?? record(operations?.trafficLineAvailability);
  const endpointPlan = record(availability?.endpointPlan);
  const availableVariants = Array.isArray(availability?.availableVariants)
    ? availability.availableVariants.filter((item): item is TrafficLineVariant => item === "flightRoundTrip" || item === "trainRoundTrip")
    : [];
  const variants = (["flightRoundTrip", "trainRoundTrip"] as const).filter((variant) => availableVariants.includes(variant));
  const automation = record(product.automation);
  const trafficProgress = record(automation?.trafficLine);
  const children = Array.isArray(trafficProgress?.children) ? trafficProgress.children : [];
  return variants.flatMap((variant) => {
    const route = record(endpointPlan?.[variant === "flightRoundTrip" ? "flight" : "train"]);
    const train = variant === "trainRoundTrip";
    const arrival = stationLabel(route?.arrival, train);
    const departure = stationLabel(route?.departure, train);
    const child = children.find((item) => record(item)?.variant === variant);
    const progress = record(child);
    const resourceState = progress?.verified === true
      ? "verified"
      : progress?.skipped === true ? "unavailable"
        : progress?.failureReason ? "failed"
          : product.productId ? "checking" : "awaitingResource";
    return arrival && departure ? [{ variant, arrival, departure, resourceState }] : [];
  });
}

interface ReviewSummaryTrafficProps {
  product: ProductDetail;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function AppWorkspaceReviewSummaryTraffic({
  product,
  collapsed,
  onToggleCollapsed,
}: ReviewSummaryTrafficProps) {
  const items = readTrafficReviewItems(product);
  const endpointsConfirmed = items.length > 0;
  const resourceVerified = items.filter((item) => item.resourceState === "verified").length;
  const plannedItems = items.filter((item) => item.resourceState !== "unavailable");
  const resourceComplete = product.productId
    && plannedItems.length > 0 && resourceVerified === plannedItems.length;
  const resourceFailed = items.some((item) => item.resourceState === "failed");
  const headerMeta = !endpointsConfirmed
    ? "待核验"
    : product.productId && resourceComplete
      ? `${resourceVerified}/${items.length} 类班期已核验`
      : !product.productId
        ? `${items.length} 类端点已确认`
        : resourceFailed ? "班期核验需处理" : `${resourceVerified}/${plannedItems.length} 类班期已核验`;

  return (
    <section
      className={styles.block}
      aria-label="大交通核验"
      data-collapsed={collapsed}
      data-state={resourceComplete ? "verified" : resourceFailed ? "failed" : "pending"}
      data-testid="review-traffic-availability"
    >
      <button
        type="button"
        className={styles.head}
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        aria-controls="traffic-review-body"
      >
        <span className={styles.headIcon}><BadgeCheck size={15} aria-hidden="true" /></span>
        <strong className={styles.headTitle}>大交通核验</strong>
        <span className={styles.headMeta}>{headerMeta}</span>
        <span className={styles.headChevron} aria-hidden="true"><ChevronDown size={13} /></span>
      </button>
      {!collapsed && (
        <div className={styles.body} id="traffic-review-body">
          {endpointsConfirmed ? (
            <div className={styles.items}>
              {items.map((item) => {
                const Icon = item.variant === "flightRoundTrip" ? Plane : TrainFront;
                const label = item.variant === "flightRoundTrip" ? "飞机往返" : "火车往返（含高铁）";
                return (
                  <div className={styles.item} key={item.variant}>
                    <span className={styles.itemIcon}><Icon size={15} aria-hidden="true" /></span>
                    <div className={styles.itemMain}>
                      <strong>{label}</strong>
                      <span>抵达 {item.arrival} · 返程 {item.departure}</span>
                    </div>
                    <span className={styles.itemState} data-state={item.resourceState}>
                      {item.resourceState === "verified" ? "班期资源已确认"
                        : item.resourceState === "unavailable" ? "本班期无资源"
                            : item.resourceState === "failed" ? "班期核验需处理"
                              : item.resourceState === "checking" ? "正在核验班期资源"
                              : "端点已确认，待核验班期资源"}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.empty}>
              <strong>尚未获取大交通端点</strong>
              <span>完成飞机与高铁端点查询后，结果会显示在这里。</span>
            </div>
          )}
          <p className={styles.note}>
            {endpointsConfirmed
              ? "产品数据准备阶段只核验当前会话可用的端点；创建子产品后才执行 VBK 正式班期资源校验和最终回读。"
              : "此处只展示当前会话已确认的端点，不从行程内容推测。"}
          </p>
        </div>
      )}
    </section>
  );
}
