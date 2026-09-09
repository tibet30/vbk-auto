import { AlertTriangle, CheckCircle2, Circle, LoaderCircle, Plane, TrainFront } from "lucide-react";
import type { ProductDetail } from "../../../shared/contracts.js";
import styles from "./traffic-line-progress.module.less";

type TransportKind = "flightRoundTrip" | "trainRoundTrip";
type UnknownRecord = Record<string, unknown>;

type ChildView = {
  kind: TransportKind;
  status: string;
  childId?: string;
  arrival?: string;
  departure?: string;
  endpointVerified?: boolean;
  error?: string;
  nodes: Array<{ key: string; label: string; status: "pending" | "running" | "done" | "failed"; error?: string }>;
};

const NODE_LABELS = [
  ["planned", "已规划"],
  ["stationsResolved", "地点已核实"],
  ["childCreated", "子产品已创建"],
  ["presentationCopied", "图文已复制"],
  ["resourcesSaved", "资源已保存"],
  ["itinerarySaved", "行程已保存"],
  ["clausesSaved", "条款已保存"],
  ["activated", "子产品已激活"],
  ["finalReadback", "最终回读"],
] as const;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function text(...values: unknown[]): string | undefined {
  return values.find((value): value is string | number => typeof value === "string" || typeof value === "number")?.toString().trim() || undefined;
}

function place(value: unknown): string | undefined {
  const item = record(value);
  if (!item) return text(value);
  return text(item.name, item.stationName, item.airportName, item.label, item.code, item.stationCode, item.airportCode);
}

function verifiedEndpoints(
  automation: ProductDetail["automation"],
  product: ProductDetail["product"],
): Partial<Record<TransportKind, Pick<ChildView, "arrival" | "departure">>> {
  const root = record(product);
  const operations = record(root?.operations);
  const trafficLine = record(operations?.trafficLine);
  // 已完成的旧版只读核验会以 operations.trafficLineAvailability 留存；
  // 新流程优先使用与配置同行的 availability，二者均来自受控端点查询。
  const availability = record(trafficLine?.availability) ?? record(operations?.trafficLineAvailability);
  // 自动化检查点的 endpointPlan 同样只在受控候选核验成功后写入；用它
  // 支持既有产品的只读复核记录，无须把它伪装成已创建的子产品。
  const checkpoint = record(record(automation)?.trafficLine);
  const endpointPlan = record(availability?.endpointPlan) ?? record(checkpoint?.endpointPlan);
  const variants = Array.isArray(availability?.availableVariants)
    ? availability.availableVariants
    : (["flight", "train"] as const).flatMap((kind) => record(endpointPlan?.[kind]) ? [kind === "flight" ? "flightRoundTrip" : "trainRoundTrip"] : []);
  return (['flightRoundTrip', 'trainRoundTrip'] as const).flatMap((kind) => {
    if (!variants.includes(kind)) return [];
    const endpoints = record(endpointPlan?.[kind === 'flightRoundTrip' ? 'flight' : 'train']);
    const arrival = place(endpoints?.arrival);
    const departure = place(endpoints?.departure);
    if (!arrival || !departure) return [];
    const station = (value: string) => kind === 'trainRoundTrip' && !value.endsWith('站') ? `${value}站` : value;
    return [[kind, { arrival: station(arrival), departure: station(departure) }] as const];
  }).reduce<Partial<Record<TransportKind, Pick<ChildView, "arrival" | "departure">>>>((result, [kind, endpoints]) => {
    result[kind] = endpoints;
    return result;
  }, {});
}

function statusLabel(status: string): string {
  return ({
    pending: "待开始",
    queued: "排队中",
    running: "进行中",
    completed: "已确认",
    succeeded: "已确认",
    skipped: "已跳过",
    failed: "失败",
    needs_user: "待处理",
  } as Record<string, string>)[status] || "待确认";
}

function statusTone(status: string): "pending" | "running" | "done" | "failed" {
  if (status === "completed" || status === "succeeded") return "done";
  if (status === "failed" || status === "needs_user") return "failed";
  if (status === "running" || status === "queued") return "running";
  return "pending";
}

function childFrom(kind: TransportKind, value: unknown, endpoint?: unknown): ChildView {
  const item = record(value) || {};
  const endpointPlan = record(endpoint) || {};
  const route = record(item.route) || record(item.traffic) || item;
  const arrival = place(item.arrival) || place(route.arrival) || place(item.arrivalStation) || place(item.arrivalAirport) || place(endpointPlan.arrival);
  const departure = place(item.departure) || place(route.departure) || place(item.departureStation) || place(item.departureAirport) || place(endpointPlan.departure);
  const completed = new Set(Array.isArray(item.completedStages) ? item.completedStages.filter((stage): stage is string => typeof stage === "string") : []);
  const status = text(item.status, item.state, item.nodeStatus)
    || (item.skipped === true ? "skipped" : undefined)
    || (item.verified === true ? "completed" : text(item.failedStage) ? "failed" : completed.size ? "running" : "pending");
  const rawNodes = record(item.nodes) || record(item.workflowNodes) || {};
  const failedStage = text(item.failedStage);
  const nodes = NODE_LABELS.map(([key, label], index) => {
    const raw = record(rawNodes[key]);
    const rawStatus = text(raw?.status, raw?.state);
    const done = completed.has(key) || (key === "childCreated" && completed.has("created")) || (key === "presentationCopied" && completed.has("presentation")) || (key === "resourcesSaved" && completed.has("resources")) || (key === "itinerarySaved" && completed.has("itinerary")) || (key === "clausesSaved" && completed.has("clauses")) || (key === "activated" && completed.has("activated"));
    const nodeStatus = rawStatus === "failed" || failedStage === key ? "failed" : rawStatus === "running" ? "running" : done ? "done" : index === 0 && status === "running" ? "running" : "pending";
    return { key, label, status: nodeStatus as "pending" | "running" | "done" | "failed", error: text(raw?.error, raw?.message) || (failedStage === key ? text(item.failureReason, item.error) : undefined) };
  });
  return {
    kind,
    status,
    childId: text(item.childProductId, item.productId, item.id, item.vbkProductId),
    arrival,
    departure,
    error: text(item.error, item.message, item.lastError, item.failureReason),
    nodes,
  };
}

function childFor(trafficLine: unknown, kind: TransportKind): ChildView {
  const root = record(trafficLine) || {};
  const endpointPlan = record(root.endpointPlan);
  const children = root.children;
  if (Array.isArray(children)) {
    const match = children.find((child) => {
      const item = record(child);
      return text(item?.kind, item?.variant, item?.type) === kind;
    });
    if (match) return childFrom(kind, match, endpointPlan?.[kind === "flightRoundTrip" ? "flight" : "train"]);
  }
  const childMap = record(children);
  return childFrom(kind, root[kind] ?? childMap?.[kind], endpointPlan?.[kind === "flightRoundTrip" ? "flight" : "train"]);
}

export function TrafficLineProgress({ automation, product }: { automation: ProductDetail["automation"]; product: ProductDetail["product"] }) {
  const trafficLine = record(automation)?.trafficLine;
  const endpoints = verifiedEndpoints(automation, product);
  const cards = (["flightRoundTrip", "trainRoundTrip"] as const).map((kind) => {
    const card = childFor(trafficLine, kind);
    const verified = endpoints[kind];
    return verified ? { ...card, ...verified, endpointVerified: true } : card;
  });
  const overallError = text(record(trafficLine)?.error, record(trafficLine)?.lastError, record(trafficLine)?.failureReason);
  return <section className={styles.section} aria-labelledby="traffic-line-progress-title">
    <div className={styles.header}>
      <div>
        <strong id="traffic-line-progress-title">线路及交通规划</strong>
        <small>产品准备阶段先核验端点和代表日期班次；通过后才进入 VBK 子产品创建。</small>
      </div>
      {overallError ? <AlertTriangle size={15} aria-hidden="true" /> : null}
    </div>
    <div className={styles.cards}>
      {cards.map((card) => {
        const tone = statusTone(card.status);
        const Icon = card.kind === "flightRoundTrip" ? Plane : TrainFront;
        return <article className={styles.card} data-state={tone} key={card.kind}>
          <div className={styles.cardHead}>
            <span className={styles.icon}><Icon size={15} aria-hidden="true" /></span>
            <strong>{card.kind === "flightRoundTrip" ? "飞机往返" : "火车往返"}</strong>
            <span className={styles.state} data-state={tone}>
              {tone === "done" ? <CheckCircle2 size={13} aria-hidden="true" /> : tone === "running" ? <LoaderCircle size={13} className={styles.spin} aria-hidden="true" /> : tone === "failed" ? <AlertTriangle size={13} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}
              {statusLabel(card.status)}
            </span>
          </div>
          {card.endpointVerified ? <p className={styles.endpointVerified}><CheckCircle2 size={12} aria-hidden="true" />前置班次已通过 · 待写入 VBK</p> : null}
          <dl className={styles.details}>
            <div><dt>抵达</dt><dd>{card.arrival || "待根据行程规划"}</dd></div>
            <div><dt>返程</dt><dd>{card.departure || "待根据行程规划"}</dd></div>
            <div><dt>VBK 子产品</dt><dd>{card.childId || "尚未创建"}</dd></div>
          </dl>
          <div className={styles.nodes} aria-label={`${card.kind === "flightRoundTrip" ? "飞机" : "火车"}子产品创建流程`}>
            {card.nodes.map((node) => <div className={styles.node} data-state={node.status} key={node.key}>
              <span className={styles.nodeDot} aria-hidden="true" />
              <span>{node.label}</span>
              {node.error ? <span className={styles.nodeError} title={node.error}>{node.error}</span> : null}
            </div>)}
          </div>
          {card.error ? <p className={styles.error} role="alert"><AlertTriangle size={13} />{card.error}</p> : null}
        </article>;
      })}
    </div>
  </section>;
}
