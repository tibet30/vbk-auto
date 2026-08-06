import { AlertTriangle, CheckCircle2, CircleHelp, Filter, History, LoaderCircle, RefreshCw, Search, SkipForward, X } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  OperationLogEntry,
  OperationLogPage,
  OperationStatus,
  OperationType,
} from "../../../../shared/contracts.js";
import shared from "../shared.module.less";
import { OPERATION_STATUS_OPTIONS } from "../../helpers";
import { OperationLogRow } from "./OperationLogRow";
import { OPERATION_TYPE_LABEL } from "./OperationTypeIcon";
import { EmptyLogState, OperationLogSkeleton, SummaryCard, formatRefreshedAt, useOperationLogState, type Notice } from "./helpers";
import sharedOp from "./shared.module.less";
import summaryStyles from "./summary.module.less";
import toolbarStyles from "./toolbar.module.less";
import styles from "./index.module.less";

export { formatRefreshedAt, useOperationLogState };

const TYPE_FILTER_OPTIONS: Array<{ value: OperationType | "all"; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "click", label: OPERATION_TYPE_LABEL.click },
  { value: "input", label: OPERATION_TYPE_LABEL.input },
  { value: "navigate", label: OPERATION_TYPE_LABEL.navigate },
  { value: "verify", label: OPERATION_TYPE_LABEL.verify },
  { value: "screenshot", label: OPERATION_TYPE_LABEL.screenshot },
  { value: "wait", label: OPERATION_TYPE_LABEL.wait },
  { value: "select", label: OPERATION_TYPE_LABEL.select },
  { value: "upload", label: OPERATION_TYPE_LABEL.upload },
];

const STATUS_FILTERS = OPERATION_STATUS_OPTIONS;

export function AppOperationLogPage({
  loading,
  page,
  refreshedAtLabel,
  onRefresh,
  onRetry,
  onShowDetail,
  notice,
  onDismissNotice,
}: {
  loading: boolean;
  page: OperationLogPage | null;
  refreshedAtLabel: string;
  onRefresh: () => Promise<void> | void;
  onRetry: (entry: OperationLogEntry) => Promise<void> | void;
  onShowDetail: (entry: OperationLogEntry) => void;
  notice: Notice;
  onDismissNotice: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<OperationStatus | "all">("all");
  const [type, setType] = useState<OperationType | "all">("all");
  const [stage, setStage] = useState<string>("all");

  const stages = page?.stages ?? [];
  const summary = page?.summary ?? { total: 0, succeeded: 0, failed: 0, skipped: 0, running: 0 };
  const entries = page?.entries ?? [];

  // 把本地筛选条件同步成 query 字符串，便于在地址栏复现 / 复制。
  const filterChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; onClear: () => void }> = [];
    if (query.trim()) {
      chips.push({ key: "q", label: `关键词：${query.trim()}`, onClear: () => setQuery("") });
    }
    if (status !== "all") {
      chips.push({
        key: "status",
        label: `状态：${STATUS_FILTERS.find((item) => item.value === status)?.label ?? status}`,
        onClear: () => setStatus("all"),
      });
    }
    if (type !== "all") {
      chips.push({
        key: "type",
        label: `类型：${TYPE_FILTER_OPTIONS.find((item) => item.value === type)?.label ?? type}`,
        onClear: () => setType("all"),
      });
    }
    if (stage !== "all") {
      chips.push({ key: "stage", label: `阶段：${stage}`, onClear: () => setStage("all") });
    }
    return chips;
  }, [query, status, type, stage]);

  // 过滤后的条目数（在 header 右侧显示），让用户对"被过滤掉了多少"有感知。
  const filteredCount = entries.length;

  const clearAll = () => {
    setQuery("");
    setStatus("all");
    setType("all");
    setStage("all");
  };

  return (
    <section className={styles.opLog}>
      <div className={styles.opLogContainer}>
        <header className={styles.opLogHead}>
          <div className={styles.opLogHeadBody}>
            <h1>操作日志</h1>
            <p className={shared.viewSub}>查看自动化操作的历史记录，支持按状态、类型和阶段定位失败原因。</p>
          </div>
          <div className={styles.opLogHeadMeta}>
            <span className={styles.opLogRefreshed}>
              <History size={12} aria-hidden="true" />
              最近更新：{refreshedAtLabel}
            </span>
            <button
              className={shared.btn}
              data-variant="ghost"
              onClick={() => void onRefresh()}
              disabled={loading}
              type="button"
            >
              {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
              刷新
            </button>
          </div>
        </header>

        {notice && (
          <div className={styles.opLogNotice} data-kind={notice.kind} role={notice.kind === "warn" ? "alert" : "status"}>
            <span className={styles.opLogNoticeText}>{notice.text}</span>
            <button className={sharedOp.opIconBtn} onClick={onDismissNotice} aria-label="关闭提示">
              <X size={13} />
            </button>
          </div>
        )}

        <section className={summaryStyles.opSummary} aria-label="日志统计">
          <SummaryCard
            icon={<History size={16} aria-hidden="true" />}
            label="总操作"
            value={summary.total}
            tone="neutral"
            sublabel={summary.running > 0 ? `进行中 ${summary.running}` : "全部记录"}
          />
          <SummaryCard
            icon={<CheckCircle2 size={16} aria-hidden="true" />}
            label="成功"
            value={summary.succeeded}
            tone="ok"
            sublabel={summary.total ? `${Math.round((summary.succeeded / summary.total) * 100)}% 通过率` : "暂无"}
          />
          <SummaryCard
            icon={<AlertTriangle size={16} aria-hidden="true" />}
            label="失败"
            value={summary.failed}
            tone="block"
            sublabel={summary.failed > 0 ? "需要关注" : "无失败记录"}
          />
          <SummaryCard
            icon={<SkipForward size={16} aria-hidden="true" />}
            label="跳过"
            value={summary.skipped}
            tone="skip"
            sublabel="运营手工跳过"
          />
        </section>

        <div className={toolbarStyles.opToolbar}>
          <label className={toolbarStyles.opSearch}>
            <Search size={14} aria-hidden="true" />
            <input
              className={toolbarStyles.opSearchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索操作名称、目标或错误消息"
              type="search"
              aria-label="搜索操作日志"
            />
            {query && (
              <button
                type="button"
                className={toolbarStyles.opSearchClear}
                onClick={() => setQuery("")}
                aria-label="清空搜索"
              >
                <X size={12} />
              </button>
            )}
          </label>

          <div className={toolbarStyles.opFilterGroup} role="group" aria-label="按状态筛选">
            {STATUS_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={toolbarStyles.opStatusChip}
                data-state={status === option.value ? "on" : "off"}
                data-value={option.value}
                onClick={() => setStatus(option.value)}
                aria-pressed={status === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className={toolbarStyles.opSelectors}>
            <label className={toolbarStyles.opSelect}>
              <Filter size={12} aria-hidden="true" />
              <span className={toolbarStyles.opSelectPrefix}>类型</span>
              <select
                className={toolbarStyles.opSelectInput}
                value={type}
                onChange={(event) => setType(event.target.value as OperationType | "all")}
                aria-label="按类型筛选"
              >
                {TYPE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className={toolbarStyles.opSelect}>
              <CircleHelp size={12} aria-hidden="true" />
              <span className={toolbarStyles.opSelectPrefix}>阶段</span>
              <select
                className={toolbarStyles.opSelectInput}
                value={stage}
                onChange={(event) => setStage(event.target.value)}
                aria-label="按阶段筛选"
              >
                <option value="all">全部阶段</option>
                {stages.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            {filterChips.length > 0 && (
              <button className={toolbarStyles.opClear} type="button" onClick={clearAll} aria-label="清空全部筛选">
                <X size={12} aria-hidden="true" />
                清空
              </button>
            )}
          </div>
        </div>

        {filterChips.length > 0 && (
          <div className={toolbarStyles.opChips} aria-live="polite">
            {filterChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className={toolbarStyles.opChip}
                onClick={chip.onClear}
                aria-label={`移除筛选：${chip.label}`}
              >
                <span>{chip.label}</span>
                <X size={11} aria-hidden="true" />
              </button>
            ))}
            <span className={toolbarStyles.opChipsCount}>
              匹配 {filteredCount} / {summary.total} 条
            </span>
          </div>
        )}

        <section className={styles.opList} aria-label="操作日志列表">
          {loading && entries.length === 0 ? (
            <OperationLogSkeleton />
          ) : entries.length === 0 ? (
            <EmptyLogState hasFilter={filterChips.length > 0} onClear={clearAll} />
          ) : (
            <div className={styles.opListItems}>
              {entries.map((entry) => (
                <OperationLogRow
                  key={entry.id}
                  entry={entry}
                  canRetry={entry.status === "failed" || entry.status === "skipped"}
                  onRetry={(item) => void onRetry(item)}
                  onShowDetail={onShowDetail}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
