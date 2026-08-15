import { Check, MapPin, Pencil, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../helpers";
import type { PoiSuggestCandidate, PoiSuggestDetailResult, PoiSuggestLogContext } from "../../../../shared/contracts";
import type { ItineraryTimelineSpotItem } from "./review-summary-itinerary-types";
import styles from "./review-summary-itinerary-poi.module.less";
import { logDebug } from "../../../../shared/log-timestamp.js";

type PoiManualLogContext = PoiSuggestLogContext & {
  keyword?: string;
  poiName?: string;
  poiId?: number;
  errorMessage?: string;
};

const POI_MANUAL_LOG_PREFIX = "[poi.manual]";

function logPoiManual(event: string, context: PoiManualLogContext) {
  if (!import.meta.env.DEV) return;
  logDebug(POI_MANUAL_LOG_PREFIX, event, { stage: event, ...context });
}

export function ItinerarySpotPoiEditor({ localProductId, item }: { localProductId: string; item: ItineraryTimelineSpotItem }) {
  const hasPoi = Boolean(item.poiName?.trim() && item.poiId);
  const [editing, setEditing] = useState(false);
  const [keyword, setKeyword] = useState(item.title);
  const [detail, setDetail] = useState<PoiSuggestDetailResult | null>(null);
  const [selected, setSelected] = useState<PoiSuggestCandidate | null>(null);
  const [loading, setLoading] = useState<"search" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logContext = (extra: Partial<PoiManualLogContext> = {}): PoiManualLogContext => ({
    localProductId,
    dayIndex: item.dayIndex,
    spotIndex: item.spotIndex,
    title: item.title,
    keyword,
    poiName: item.poiName ?? undefined,
    poiId: item.poiId ?? undefined,
    ...extra,
  });

  useEffect(() => {
    setEditing(false);
    setKeyword(item.title);
    setDetail(null);
    setSelected(null);
    setLoading(null);
    setError(null);
  }, [item.dayIndex, item.spotIndex, item.poiName, item.poiId, item.title]);

  const startEdit = () => {
    const nextKeyword = item.poiName?.trim() || item.title;
    setEditing(true);
    setKeyword(nextKeyword);
    setDetail(null);
    setSelected(null);
    setError(null);
    logPoiManual("open_edit", logContext({ keyword: nextKeyword }));
  };

  const cancel = () => {
    logPoiManual("cancel", logContext());
    setEditing(false);
    setKeyword(item.title);
    setDetail(null);
    setSelected(null);
    setError(null);
    setLoading(null);
  };

  const searchPoi = async () => {
    const query = keyword.trim();
    logPoiManual("search_start", logContext({ keyword: query }));
    if (!query) {
      setError("请输入 POI 搜索关键词。");
      setDetail(null);
      setSelected(null);
      return;
    }
    if (!api()) {
      logPoiManual("search_failure", logContext({ keyword: query, errorMessage: "renderer api unavailable" }));
      setError("当前环境无法访问 VBK POI 搜索。");
      return;
    }
    setLoading("search");
    setError(null);
    setDetail(null);
    setSelected(null);
    try {
      const next = await api()!.browser.suggestPoiDetail(query, {
        localProductId,
        dayIndex: item.dayIndex,
        spotIndex: item.spotIndex,
        title: item.title,
      });
      const firstSelectable = next.candidates.find((candidate) => candidate.selectable);
      setDetail(next);
      if (!next.candidates.length) setError("VBK 未返回候选 POI，请换一个关键词。");
      else if (!firstSelectable) setError("本次返回的候选缺少可保存的 poiName + poiId，仅供人工查看。");
      if (next.best) logPoiManual("search_success", logContext({
          keyword: query,
          poiName: next.best.poiName,
          poiId: next.best.poiId,
        }));
      else logPoiManual("search_empty", logContext({ keyword: query }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "VBK POI 搜索失败，请重试。";
      logPoiManual("search_failure", logContext({ keyword: query, errorMessage: message }));
      setError(message);
    } finally {
      setLoading(null);
    }
  };

  const save = async () => {
    if (!selected?.selectable || !selected.poiName || !selected.poiId || !api()) return;
    const saveTarget = { poiName: selected.poiName, poiId: selected.poiId };
    logPoiManual("save_start", logContext(saveTarget));
    setLoading("save");
    setError(null);
    try {
      await api()!.products.updateReviewField(localProductId, {
        field: "itinerarySpotPoi",
        dayIndex: item.dayIndex,
        spotIndex: item.spotIndex,
        poiName: saveTarget.poiName,
        poiId: saveTarget.poiId,
      });
      logPoiManual("save_success", logContext(saveTarget));
      setEditing(false);
      setDetail(null);
      setSelected(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "保存 POI 失败，请重试。";
      logPoiManual("save_failure", logContext({ ...saveTarget, errorMessage: message }));
      setError(message);
    } finally {
      setLoading(null);
    }
  };

  if (!editing) {
    return (
      <div className={styles.status} data-state={hasPoi ? "matched" : "missing"}>
        <span className={styles.text}>
          {hasPoi ? `已匹配：${item.poiName}（${item.poiId}）` : "待核查 POI"}
        </span>
        {!hasPoi && (
          <button
            type="button"
            className={styles.iconButton}
            onClick={startEdit}
            title={`编辑 ${item.title} 的 VBK POI`}
            aria-label={`编辑 ${item.title} 的 VBK POI`}
          >
            <Pencil size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={styles.editor} aria-label={`${item.title} 的 VBK POI 手动补全`}>
      <div className={styles.searchRow}>
        <input
          className={styles.input}
          value={keyword}
          onChange={(event) => {
            setKeyword(event.target.value);
            setDetail(null);
            setSelected(null);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void searchPoi(); }
            else if (event.key === "Escape") { event.preventDefault(); cancel(); }
          }}
          placeholder="输入 VBK POI 关键词"
          aria-label="VBK POI 关键词"
          disabled={loading !== null}
          autoFocus
        />
        <button
          type="button"
          className={styles.actionButton}
          onClick={() => void searchPoi()}
          disabled={loading !== null || !keyword.trim()}
          title="搜索 VBK POI"
          aria-label="搜索 VBK POI"
        >
          <Search size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.actionButton}
          onClick={cancel}
          disabled={loading === "save"}
          title="取消编辑"
          aria-label="取消编辑 POI"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      {detail && detail.candidates.length > 0 && (
        <div className={styles.results} aria-label="VBK POI 候选列表">
          {detail.candidates.map((candidate) => (
            <div
              key={`${candidate.index}-${candidate.poiId ?? "view"}`}
              className={styles.result}
              data-selected={selected?.index === candidate.index}
              data-selectable={candidate.selectable}
            >
              <button
                type="button"
                className={styles.resultChoice}
                disabled={!candidate.selectable || loading !== null}
                aria-pressed={selected?.index === candidate.index}
                onClick={() => {
                  if (!candidate.selectable) return;
                  setSelected(candidate);
                  logPoiManual("select_result", logContext({
                    poiName: candidate.poiName ?? undefined,
                    poiId: candidate.poiId ?? undefined,
                  }));
                }}
              >
                <span className={styles.resultHead}>
                  <MapPin size={12} aria-hidden="true" />
                  <span className={styles.resultName}>{candidate.poiName || "未返回 poiName"}</span>
                  <code>{candidate.poiId ?? "无 poiId"}</code>
                  <span className={styles.resultState}>{candidate.selectable ? "可选择" : "仅查看"}</span>
                </span>
              </button>
              {candidate.textFields.length > 0 && (
                <details className={styles.fields}>
                  <summary className={styles.fieldsSummary}>查看接口详情（{candidate.textFields.length} 项）</summary>
                  <span className={styles.fieldsList}>
                    {candidate.textFields.map((field) => (
                      <span className={styles.field} key={`${candidate.index}-${field.path}-${field.value}`}>
                        <b>{field.path}：</b>{field.value}
                      </span>
                    ))}
                  </span>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
      <button
        type="button"
        className={styles.saveButton}
        onClick={() => void save()}
        disabled={loading !== null || !selected?.selectable}
      >
        <Check size={12} aria-hidden="true" />
        {loading === "save" ? "保存中" : "保存 POI"}
      </button>
    </div>
  );
}
