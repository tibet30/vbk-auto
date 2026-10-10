import { buildTimeline, type TimelineItem, type ItineraryActivity, type ItineraryDay } from "./review-summary-itinerary-timeline";
export type { ItineraryActivity, ItineraryDay } from "./review-summary-itinerary-timeline";
import { itinerarySupportingArrangements } from "../../../../shared/itinerary-support-arrangements.js";
import { Select } from "../../helpers/Select";
import {
  CalendarDays,
  ChevronDown,
  BusFront,
  Hotel,
  MapPin,
  ShieldAlert,
  Sparkles,
  Trash2,
  Utensils,
} from "lucide-react";
import { useState } from "react";
import type { ProductReadiness } from "../../../../shared/contracts-types.js";
import { itineraryDayHasBorderPermitTrigger } from "../../../../shared/border-permit.js";
import { hasItineraryHotelStay } from "../../../../shared/itinerary-hotel.js";
import { readinessIssueSemanticKey } from "../../../../shared/readiness-issues.js";
import { stripDayPrefix } from "../../helpers";
import { api } from "../../helpers";
import shared from "../shared.module.less";
import { ItinerarySpotPoiEditor } from "./review-summary-itinerary-poi";
import type { ItineraryTimelineSpotItem } from "./review-summary-itinerary-types";
import styles from "./review-summary-itinerary.module.less";

interface ReviewSummaryItineraryProps {
  localProductId: string;
  days: ItineraryDay[];
  expandedDayIndexes: Set<number>;
  onToggle: (index: number) => void;
  /** 整个「每日行程」模块是否被收起。 */
  collapsed?: boolean;
  /** 切换整个「每日行程」模块的展开 / 收起。 */
  onToggleCollapsed?: () => void;
  readinessIssues?: ProductReadiness["issues"];
}

function activityIcon(type: ItineraryActivity["type"]) {
  if (type === "meal") return <Utensils size={11} aria-hidden="true" />;
  if (type === "hotel") return <Hotel size={11} aria-hidden="true" />;
  if (type === "transport") return <BusFront size={11} aria-hidden="true" />;
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
 * - 默认仅展开第一天（与 expandedDayIndexes 默认含 0 对齐），其他天折叠成一行摘要；
 * - 展开时显示按时间顺序排列的景点 + 活动 + 餐食时间线；
 * - 折叠时只保留 Day 编号 + 标题 + 节点计数，保持列表可快速浏览。
 * - 多天可同时展开（不互斥），再次点击已展开的天即收起该天。
 */
export function AppWorkspaceReviewSummaryItinerary({ localProductId, days, expandedDayIndexes, onToggle, collapsed = false, onToggleCollapsed, readinessIssues = [] }: ReviewSummaryItineraryProps) {
  const [removingSpotKey, setRemovingSpotKey] = useState<string | null>(null);
  const [savingKindKey, setSavingKindKey] = useState<string | null>(null);
  const borderPermitIssue = readinessIssues.find((issue) => readinessIssueSemanticKey(issue) === "travel:borderPermit");
  const removeSpot = async (item: TimelineItem) => {
    if (item.spotIndex === undefined || !api()) return;
    const confirmed = window.confirm(`确认删除「${item.title}」这一站？`);
    if (!confirmed) return;
    const key = `${item.dayIndex}-${item.spotIndex}`;
    setRemovingSpotKey(key);
    try {
      await api()!.products.updateReviewField(localProductId, {
        field: "itinerarySpotRemove",
        dayIndex: item.dayIndex,
        spotIndex: item.spotIndex,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除站点失败，请重试。";
      window.alert(message);
    } finally {
      setRemovingSpotKey((current) => (current === key ? null : current));
    }
  };
  const changeKind = async (item: TimelineItem, kind: "attraction" | "free" | "other") => {
    if (item.spotIndex === undefined || !api()) return;
    if (kind !== "attraction" && (item.poiName || item.poiId) && !window.confirm(`切换为${kind === "free" ? "自由活动" : "其他"}会清除已绑定 POI，是否继续？`)) return;
    const key = `${item.dayIndex}-${item.spotIndex}`;
    setSavingKindKey(key);
    try {
      await api()!.products.updateReviewField(localProductId, { field: "itinerarySpotKind", dayIndex: item.dayIndex, spotIndex: item.spotIndex, kind });
    } catch (error) { window.alert(error instanceof Error ? error.message : "保存行程类型失败，请重试。"); }
    finally { setSavingKindKey((current) => current === key ? null : current); }
  };

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
          const expanded = expandedDayIndexes.has(index);
          const title = stripDayPrefix(day.title || "", index);
          const timeline = buildTimeline(day, index);
          const visitCount = timeline.filter((t) => t.type === "visit").length;
          const activityCount = timeline.filter((t) => t.type === "free" || t.type === "other").length;
          const arrangements = itinerarySupportingArrangements(day);
          const hotel = day.hotel?.trim() ?? "";
          const hasHotelStay = hasItineraryHotelStay(hotel);
          const showBorderPermitHint = Boolean(borderPermitIssue) && itineraryDayHasBorderPermitTrigger(day);
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
                <span className={styles.dayNum}>D{day.day ?? index + 1}</span>
                <span className={styles.dayHeadBody}>
                  <span className={styles.dayTitle}>{title || `Day ${index + 1}`}</span>
                  <span className={styles.daySummary}>
                    {visitCount > 0 ? `${visitCount} 个景点` : arrangements.some((item) => item.type === "transport") ? "接送安排" : "当日安排"}
                    {activityCount > 0 ? ` · ${activityCount} 项活动` : ""}
                    {day.meals?.trim() ? " · 含餐食说明" : ""}
                    {hasHotelStay ? " · 含住宿" : ""}
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
                                {item.spotIndex !== undefined && (
                                  <Select className={styles.spotKind} value={item.kind ?? "attraction"} disabled={savingKindKey === `${item.dayIndex}-${item.spotIndex}`} onChange={(event) => { void changeKind(item, event.target.value as "attraction" | "free" | "other"); }} aria-label={`${item.title} 的类型`}>
                                    <option value="attraction">景点</option><option value="free">自由活动</option><option value="other">其他</option>
                                  </Select>
                                )}
                                {item.spotIndex !== undefined && (
                                  <button
                                    type="button"
                                    className={styles.spotRemove}
                                    onClick={() => { void removeSpot(item); }}
                                    disabled={removingSpotKey === `${item.dayIndex}-${item.spotIndex}`}
                                    title={`删除 ${item.title}`}
                                    aria-label={`删除 ${item.title}`}
                                  >
                                    <Trash2 size={12} aria-hidden="true" />
                                  </button>
                                )}
                              </div>
                              {item.detail && (
                                <p className={styles.timelineDetail}>{item.detail}</p>
                              )}
                              {(item.kind === "free" || item.kind === "other") && <p className={styles.timelineDetail}>无需配置 POI</p>}
                              {item.spotIndex !== undefined && item.kind !== "free" && item.kind !== "other" && (
                                <ItinerarySpotPoiEditor
                                  localProductId={localProductId}
                                  item={{
                                    title: item.title,
                                    dayIndex: item.dayIndex,
                                    spotIndex: item.spotIndex,
                                    poiName: item.poiName,
                                    poiId: item.poiId,
                                    province: item.province,
                                    city: item.city,
                                    district: item.district,
                                    kind: item.kind,
                                  }}
                                />
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <>{arrangements.length === 0 && <p className={styles.timelineEmpty}>本天尚无游览安排。</p>}</>
                  )}
                  {arrangements.filter((item) => item.type !== "hotel").map((item, i) => (
                    <div className={styles.supportRow} key={`support-${i}`}>
                      <span className={styles.hotelIcon}>{activityIcon(item.type)}</span>
                      <div className={styles.hotelBody}>
                        <strong className={styles.hotelTitle}>{item.type === "transport" ? "接送安排" : "餐食"}</strong>
                        <span className={styles.hotelText}>{item.detail || item.title}</span>
                      </div>
                    </div>
                  ))}
                  {hotel && (
                    <div className={styles.hotelCard}>
                      <span className={styles.hotelIcon}><Hotel size={12} aria-hidden="true" /></span>
                      <div className={styles.hotelBody}>
                        <strong className={styles.hotelTitle}>住宿</strong>
                        <span className={styles.hotelText}>{hotel}</span>
                        {day.hotelDescription && day.hotelDescription !== hotel && (
                          <span className={styles.hotelText}>{day.hotelDescription}</span>
                        )}
                      </div>
                    </div>
                  )}
                  {showBorderPermitHint && borderPermitIssue && (
                    <div className={styles.permitCard}>
                      <span className={styles.permitIcon}><ShieldAlert size={12} aria-hidden="true" /></span>
                      <div className={styles.permitBody}>
                        <strong className={styles.permitTitle}>证件提示</strong>
                        <span className={styles.permitText}>{borderPermitIssue.detail}</span>
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
