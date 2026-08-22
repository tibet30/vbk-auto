import { AlertTriangle, Bug, CircleHelp, Download, History, Info, ListFilter, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LogLevel, LogSource, OperationLogEntry, OperationLogPage, OperationLogQuery, OperationStatus, OperationType } from "../../../../shared/contracts.js";
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

const LEVEL_OPTIONS: Array<{ value: LogLevel | "all"; label: string }> = [
  { value: "all", label: "全部级别" }, { value: "error", label: "错误" },
  { value: "warn", label: "警告" }, { value: "info", label: "信息" }, { value: "debug", label: "调试" },
];
const SOURCE_OPTIONS: Array<{ value: LogSource | "all"; label: string }> = [
  { value: "all", label: "全部来源" }, { value: "main", label: "主进程" },
  { value: "renderer", label: "页面" }, { value: "automation", label: "自动化" }, { value: "system", label: "系统" },
];
const TYPE_OPTIONS: Array<{ value: OperationType | "all"; label: string }> = [
  { value: "all", label: "全部类型" }, { value: "runtime", label: "运行输出" },
  ...(["click", "input", "navigate", "verify", "screenshot", "wait", "select", "upload"] as OperationType[])
    .map((value) => ({ value, label: OPERATION_TYPE_LABEL[value] })),
];

export function AppOperationLogPage({
  loading, page, refreshedAtLabel, onRefresh, onExport, onRetry, onShowDetail, notice, onDismissNotice,
}: {
  loading: boolean;
  page: OperationLogPage | null;
  refreshedAtLabel: string;
  onRefresh: (query: OperationLogQuery) => Promise<void> | void;
  onExport: (query: OperationLogQuery) => Promise<void> | void;
  onRetry: (entry: OperationLogEntry) => Promise<void> | void;
  onShowDetail: (entry: OperationLogEntry) => void;
  notice: Notice;
  onDismissNotice: () => void;
}) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [source, setSource] = useState<LogSource | "all">("all");
  const [type, setType] = useState<OperationType | "all">("all");
  const [status, setStatus] = useState<OperationStatus | "all">("all");
  const [stage, setStage] = useState("all");
  const [exporting, setExporting] = useState(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const filter: OperationLogQuery = useMemo(() => ({ query: query.trim() || undefined, level, source, type, status, stage }), [query, level, source, type, status, stage]);
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshRef.current(filter), query ? 240 : 0);
    return () => window.clearTimeout(timer);
  }, [filterKey]);
  useEffect(() => {
    const timer = window.setInterval(() => void refreshRef.current(filter), 2_500);
    return () => window.clearInterval(timer);
  }, [filterKey]);

  const summary = page?.summary ?? { total: 0, succeeded: 0, failed: 0, skipped: 0, running: 0, debug: 0, info: 0, warn: 0, error: 0 };
  const entries = page?.entries ?? [];
  const hasFilter = Boolean(query.trim() || level !== "all" || source !== "all" || type !== "all" || status !== "all" || stage !== "all");
  const activeFilterCount = [level, source, type, status, stage].filter((value) => value !== "all").length;
  const clearAll = () => { setQuery(""); setLevel("all"); setSource("all"); setType("all"); setStatus("all"); setStage("all"); };
  const exportCurrent = async () => { setExporting(true); try { await onExport(filter); } finally { setExporting(false); } };

  return (
    <section className={styles.opLog}>
      <div className={styles.opLogContainer}>
        <header className={styles.opLogHead}>
          <div className={styles.opLogHeadBody}>
            <h1>运行日志</h1>
            <p className={shared.viewSub}>集中查看主进程、页面与自动化输出；敏感字段会在保存和导出前自动脱敏。</p>
          </div>
          <div className={styles.opLogHeadMeta}>
            <span className={styles.opLogRefreshed}><History size={12} />最近更新：{refreshedAtLabel}</span>
            <button className={shared.btn} data-variant="ghost" onClick={() => void onRefresh(filter)} disabled={loading} type="button">
              {loading ? <LoaderCircle size={14} className={styles.spinning} /> : <RefreshCw size={14} />}刷新
            </button>
            <button className={shared.btn} onClick={() => void exportCurrent()} disabled={exporting || loading} type="button">
              {exporting ? <LoaderCircle size={14} className={styles.spinning} /> : <Download size={14} />}导出当前结果
            </button>
          </div>
        </header>

        {notice && <div className={styles.opLogNotice} data-kind={notice.kind} role={notice.kind === "warn" ? "alert" : "status"}>
          <span className={styles.opLogNoticeText}>{notice.text}</span>
          {notice.action && <button className={styles.opLogNoticeAction} onClick={notice.action.onClick} type="button" title="用默认方式打开该文件">{notice.action.label}</button>}
          <button className={sharedOp.opIconBtn} onClick={onDismissNotice} aria-label="关闭提示"><X size={13} /></button>
        </div>}

        <section className={summaryStyles.opSummary} aria-label="日志统计">
          <SummaryCard icon={<History size={16} />} label="当前结果" value={summary.total} tone="neutral" sublabel="最多保留最近 10,000 条" onClick={() => setLevel("all")} active={level === "all"} />
          <SummaryCard icon={<AlertTriangle size={16} />} label="错误" value={summary.error} tone="block" sublabel={summary.error ? "需要优先处理" : "没有错误"} onClick={() => setLevel(level === "error" ? "all" : "error")} active={level === "error"} />
          <SummaryCard icon={<CircleHelp size={16} />} label="警告" value={summary.warn} tone="skip" sublabel="可能影响执行结果" onClick={() => setLevel(level === "warn" ? "all" : "warn")} active={level === "warn"} />
          <SummaryCard icon={level === "debug" ? <Bug size={16} /> : <Info size={16} />} label="信息与调试" value={summary.info + summary.debug} tone="ai" sublabel={`信息 ${summary.info} · 调试 ${summary.debug}`} onClick={() => setLevel(level === "info" ? "all" : "info")} active={level === "info"} />
        </section>

        <div className={toolbarStyles.opToolbar}>
          <div className={toolbarStyles.opToolbarTop}>
            <label className={toolbarStyles.opSearch}>
              <Search size={15} /><input className={toolbarStyles.opSearchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索消息、模块、产品、阶段或目标" type="search" aria-label="搜索运行日志" />
              {query && <button type="button" className={toolbarStyles.opSearchClear} onClick={() => setQuery("")} aria-label="清空搜索"><X size={12} /></button>}
            </label>
            {hasFilter && <button className={toolbarStyles.opClear} type="button" onClick={clearAll}><X size={12} />重置全部</button>}
          </div>
          <div className={toolbarStyles.opFilterBar}>
            <div className={toolbarStyles.opFilterLabel}>
              <ListFilter size={13} aria-hidden="true" />
              <span>筛选</span>
              {activeFilterCount > 0 && <span className={toolbarStyles.opFilterCount}>{activeFilterCount}</span>}
            </div>
            <div className={toolbarStyles.opSelectors}>
              <LogSelect label="级别" value={level} onChange={(value) => setLevel(value as LogLevel | "all")} options={LEVEL_OPTIONS} />
              <LogSelect label="来源" value={source} onChange={(value) => setSource(value as LogSource | "all")} options={SOURCE_OPTIONS} />
              <LogSelect label="类型" value={type} onChange={(value) => setType(value as OperationType | "all")} options={TYPE_OPTIONS} />
              <LogSelect label="状态" value={status} onChange={(value) => setStatus(value as OperationStatus | "all")} options={OPERATION_STATUS_OPTIONS} />
              <LogSelect label="阶段" value={stage} onChange={setStage} options={[{ value: "all", label: "全部阶段" }, ...(page?.stages ?? []).map((value) => ({ value, label: value }))]} />
            </div>
          </div>
        </div>

        <div className={styles.opResultMeta} aria-live="polite"><span>显示 {entries.length} 条</span><span>·</span><span>每 2.5 秒自动刷新</span><span>·</span><span>导出遵循当前筛选</span></div>
        <section className={styles.opList} aria-label="运行日志列表">
          {loading && entries.length === 0 ? <OperationLogSkeleton /> : entries.length === 0 ? <EmptyLogState hasFilter={hasFilter} onClear={clearAll} /> :
            <div className={styles.opListItems}>{entries.map((entry) => <OperationLogRow key={entry.id} entry={entry} canRetry={entry.type !== "runtime" && (entry.status === "failed" || entry.status === "skipped")} onRetry={(item) => void onRetry(item)} onShowDetail={onShowDetail} />)}</div>}
        </section>
      </div>
    </section>
  );
}

function LogSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <label className={toolbarStyles.opSelect}><span className={toolbarStyles.opSelectPrefix}>{label}</span><select className={toolbarStyles.opSelectInput} value={value} onChange={(event) => onChange(event.target.value)} aria-label={`按${label}筛选`}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}
