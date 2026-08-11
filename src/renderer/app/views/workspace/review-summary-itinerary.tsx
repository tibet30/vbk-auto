import {
  CalendarDays,
  ChevronDown,
  Coffee,
  Hotel,
  MapPin,
  Sparkles,
  Utensils,
} from "lucide-react";
import { stripDayPrefix } from "../../helpers";
import shared from "../shared.module.less";
import { ItinerarySpotPoiEditor } from "./review-summary-itinerary-poi";
import styles from "./review-summary-itinerary.module.less";

export interface ItineraryActivity {
  time: string;
  title: string;
  detail?: string;
  type?: "transport" | "visit" | "meal" | "hotel" | "free" | "other";
}

export interface ItineraryDay {
  day?: number;
  title?: string;
  spots?: Array<{ name: string; poiName?: string | null; poiId?: number | null }>;
  description?: string;
  hotel?: string;
  hotelDescription?: string;
  meals?: string;
  mealDescriptions?: string[];
  activities?: ItineraryActivity[];
}

interface ReviewSummaryItineraryProps {
  projectId: string;
  days: ItineraryDay[];
  expandedDayIndex: number | null;
  onToggle: (index: number) => void;
  /** 整个「每日行程」模块是否被收起。 */
  collapsed?: boolean;
  /** 切换整个「每日行程」模块的展开 / 收起。 */
  onToggleCollapsed?: () => void;
}

export interface ItineraryTimelineSpotItem {
  title: string;
  dayIndex: number;
  spotIndex: number;
  poiName?: string | null;
  poiId?: number | null;
}

interface TimelineItem {
  key: string;
  time: string;
  title: string;
  detail?: string;
  type: ItineraryActivity["type"];
  dayIndex: number;
  spotIndex?: number;
  poiName?: string | null;
  poiId?: number | null;
}

/**
 * 把 Day 的 activities 与 spots 合并成一条从上到下的时间线。
 * - activities 已有 time/Title，直接使用，按 time 升序排列；
 * - 没有 time 的 spots 视作「待安排」占位，排在末尾；
 * - meals 字段作为独立的「用餐」节点插入到活动之间（紧跟其前一个 visit 之后）。
 */
function buildTimeline(day: ItineraryDay, dayIndex: number): TimelineItem[] {
  const activities = (day.activities ?? []).slice();
  const spots = (day.spots ?? []).filter(Boolean);
  const meals = day.meals?.trim() ?? "";
  const items: TimelineItem[] = [];

  const claimedSpotIndexes = new Set<number>();
  const activityItems: TimelineItem[] = activities.map((act, idx) => {
    const canAttachSpot = act.type === "visit" || act.type === undefined || act.type === "other";
    const spotIndex = canAttachSpot
      ? spots.findIndex((spot, index) => !claimedSpotIndexes.has(index) && spot.name.trim() === act.title.trim())
      : -1;
    const spot = spotIndex >= 0 ? spots[spotIndex] : undefined;
    if (spotIndex >= 0) claimedSpotIndexes.add(spotIndex);
    return {
      key: `act-${idx}`,
      time: act.time || "",
      title: act.title,
      detail: act.detail,
      type: spot ? "visit" : act.type ?? "other",
      dayIndex,
      spotIndex: spotIndex >= 0 ? spotIndex : undefined,
      poiName: spot?.poiName ?? null,
      poiId: spot?.poiId ?? null,
    };
  });

  // spots 未在 activities 里出现的，追加到末尾作为未排时间的景点。
  const usedTitles = new Set(activityItems.map((a) => a.title.trim()));
  const spotItems: TimelineItem[] = spots
    .map((spot, index) => ({ spot, index }))
    .filter(({ spot, index }) => !claimedSpotIndexes.has(index) && !usedTitles.has(spot.name.trim()))
    .map<TimelineItem>(({ spot, index }) => ({
      key: `spot-${index}`,
      time: "",
      title: spot.name,
      detail: undefined,
      type: "visit",
      dayIndex,
      spotIndex: index,
      poiName: spot.poiName ?? null,
      poiId: spot.poiId ?? null,
    }));

  items.push(...activityItems, ...spotItems);

  // 用餐节点：作为单独的餐食条目插入（meal 类型），紧跟 visit 之后。
  if (meals && !items.some((item) => item.type === "meal")) {
    const insertAt = (() => {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type === "visit") return i + 1;
      }
      return items.length;
    })();
    items.splice(insertAt, 0, {
      key: "meal",
      time: "",
      title: meals,
      type: "meal",
      dayIndex,
    });
  }

  // 按 time 升序排序（有 time 的排前）。
  items.sort((a, b) => {
    const at = parseTimeOrInfinity(a.time);
    const bt = parseTimeOrInfinity(b.time);
    return at - bt;
  });

  return items;
}

function parseTimeOrInfinity(raw: string): number {
  const match = raw.match(/^(\d{1,2}):?(\d{2})?$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return Number.POSITIVE_INFINITY;
  return hours * 60 + minutes;
}

function activityIcon(type: ItineraryActivity["type"]) {
  if (type === "meal") return <Utensils size={11} aria-hidden="true" />;
  if (type === "hotel") return <Hotel size={11} aria-hidden="true" />;
  if (type === "transport") return <Coffee size={11} aria-hidden="true" />;
  if (type === "visit") return <MapPin size={11} aria-hidden="true" />;
  return <Sparkles size={11} aria-hidden="true" />;
}

function activityNodeClass(type: ItineraryActivity["type"]): string {
  if (type === "meal") return styles.timelineNodeMeal ?? "";
  if (type === "hotel") return styles.timelineNodeHotel ?? "";
  if (type === "transport") return styles.timelineNodeTransport ?? "";
  if (type === "visit") return styles.timelineNodeVisit ?? "";
  return styles.timelineNodeOther ?? "";
}

/**
 * 每日行程：右侧 review 阶段的视觉重点。
 * - 默认仅展开第一天（与 expandedDayIndex 默认 0 对齐），其他天折叠成一行摘要；
 * - 展开时显示按时间顺序排列的景点 + 活动 + 餐食时间线；
 * - 折叠时只保留 Day 编号 + 标题 + 节点计数，保持列表可快速浏览。
 */
export function AppWorkspaceReviewSummaryItinerary({ projectId, days, expandedDayIndex, onToggle, collapsed = false, onToggleCollapsed }: ReviewSummaryItineraryProps) {
  // 折叠时不渲染 dayList，节省节点；header 仍然可点击重新展开。
  const renderHeader = (meta: React.ReactNode, bodyId: string) => (
    <button
      type="button"
      className={styles.head}
      onClick={onToggleCollapsed}
      aria-expanded={!collapsed}
      aria-controls={bodyId}
    >
      <span className={styles.headIcon}><CalendarDays size={13} aria-hidden="true" /></span>
      <strong className={styles.headTitle}>每日行程</strong>
      <small className={styles.headMeta}>{meta}</small>
      <span className={styles.headChevron} aria-hidden="true">
        <ChevronDown size={13} />
      </span>
    </button>
  );

  if (days.length === 0) {
    return (
      <section className={styles.block} aria-label="每日行程" data-collapsed={collapsed}>
        {renderHeader("等待 AI 生成", "itinerary-empty-body")}
        <p className={`${shared.sectionEmpty} ${styles.emptyHint}`}>
          AI 尚未写入每日行程 — 在左侧继续对话补齐。
        </p>
      </section>
    );
  }

  return (
    <section className={styles.block} aria-label="每日行程" data-collapsed={collapsed}>
      {renderHeader(`共 ${days.length} 天`, "itinerary-day-body")}
      <ol className={styles.dayList} id="itinerary-day-body">
        {days.map((day, index) => {
          const expanded = expandedDayIndex === index;
          const title = stripDayPrefix(day.title || "", index);
          const timeline = buildTimeline(day, index);
          const visitCount = timeline.filter((t) => t.type === "visit").length;
          const mealCount = timeline.filter((t) => t.type === "meal").length;
          const hotel = day.hotel?.trim() ?? "";
          return (
            <li key={index} className={styles.dayItem} data-expanded={expanded}>
              <button
                type="button"
                className={styles.dayHead}
                data-expanded={expanded}
                onClick={() => onToggle(index)}
                aria-expanded={expanded}
                aria-controls={`day-body-${index}`}
              >
                <span className={styles.dayNum}>D{index + 1}</span>
                <span className={styles.dayHeadBody}>
                  <span className={styles.dayTitle}>{title || `Day ${index + 1}`}</span>
                  <span className={styles.daySummary}>
                    {visitCount > 0 ? `${visitCount} 个景点` : "尚无景点"}
                    {mealCount > 0 ? ` · ${mealCount} 餐` : ""}
                    {hotel ? " · 含住宿" : ""}
                  </span>
                </span>
                <span className={styles.dayChevron} aria-hidden="true">
                  <ChevronDown size={13} />
                </span>
              </button>
              {expanded && (
                <div className={styles.dayBody} id={`day-body-${index}`}>
                  {timeline.length > 0 ? (
                    <ol className={styles.timeline}>
                      {timeline.map((item, idx) => {
                        const label = item.time || `第 ${idx + 1} 站`;
                        return (
                          <li
                            key={item.key}
                            className={styles.timelineItem}
                            data-last={idx === timeline.length - 1}
                          >
                            <span className={styles.timelineRail} aria-hidden="true">
                              <span className={`${styles.timelineNode} ${activityNodeClass(item.type)}`}>
                                {activityIcon(item.type)}
                              </span>
                            </span>
                            <div className={styles.timelineContent}>
                              <div className={styles.timelineHeader}>
                                <span className={styles.timelineTime}>{label}</span>
                                <span className={styles.timelineTitle}>{item.title}</span>
                              </div>
                              {item.detail && (
                                <p className={styles.timelineDetail}>{item.detail}</p>
                              )}
                              {item.spotIndex !== undefined && (
                                <ItinerarySpotPoiEditor
                                  projectId={projectId}
                                  item={{
                                    title: item.title,
                                    dayIndex: item.dayIndex,
                                    spotIndex: item.spotIndex,
                                    poiName: item.poiName,
                                    poiId: item.poiId,
                                  }}
                                />
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className={styles.timelineEmpty}>本天尚无安排。</p>
                  )}
                  {hotel && (
                    <div className={styles.hotelCard}>
                      <span className={styles.hotelIcon}><Hotel size={12} aria-hidden="true" /></span>
                      <div className={styles.hotelBody}>
                        <strong className={styles.hotelTitle}>入住</strong>
                        <span className={styles.hotelText}>{hotel}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
