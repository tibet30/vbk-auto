import styles from "../agent-conversation.module.less";
import { buildToolResultView } from "./tool-result-model";

const GRADE_LABEL: Record<number, string> = { 3: "三钻", 4: "四钻", 5: "五钻" };

/**
 * 工具结果的结构化视图。认不出的工具走默认分支（折叠的原始 JSON），
 * 因此新增工具不需要改这里，也不会因为字段变化渲染失败。
 */
export function ToolResultBody({ name, content }: { name: string; content: string }) {
  const view = buildToolResultView(name, content);

  if (view.kind === "failure") return <div className={styles.resultFailure}>{view.message}</div>;

  if (view.kind === "poi") {
    return <div className={styles.resultCard}>
      <div className={styles.resultHead}>
        <span className={styles.resultTitle}>{view.keyword ? `景点检索 · ${view.keyword}` : "景点检索"}</span>
        <span className={styles.resultMeta}>{view.candidates.length} 个候选</span>
      </div>
      {view.scope && <div className={styles.resultRow}>
        <span className={styles.resultKey}>目标槽位</span>
        <span className={styles.resultValue}>{view.scope}</span>
      </div>}
      {view.issue && <div className={styles.resultNotice}>{view.issue}</div>}
      {view.candidates.map((candidate, index) => <div className={styles.resultRow} key={`${candidate.poiId ?? candidate.name}-${index}`}>
        <span className={styles.resultValue}>{candidate.name}</span>
        {candidate.location && <span className={styles.resultKey}>{candidate.location}</span>}
        <span className={styles.resultBadge} data-ok={candidate.bindable || undefined}>
          {candidate.bindable ? "可绑定" : candidate.note ?? "不可绑定"}
        </span>
      </div>)}
      {!view.candidates.length && <div className={styles.resultEmpty}>没有返回可用候选</div>}
    </div>;
  }

  if (view.kind === "hotel") {
    return <div className={styles.resultCard}>
      <div className={styles.resultHead}>
        <span className={styles.resultTitle}>平台自动匹配酒店</span>
        <span className={styles.resultBadge} data-ok={view.persisted || undefined}>{view.persisted ? "已保存" : "未保存"}</span>
      </div>
      {view.grades.length > 0 && <div className={styles.resultRow}>
        <span className={styles.resultKey}>钻级</span>
        <span className={styles.resultChips}>{view.grades.map((grade) =>
          <span className={styles.resultChip} key={grade}>{GRADE_LABEL[grade] ?? `${grade} 钻`}</span>)}</span>
      </div>}
      {view.note && <div className={styles.resultNotice}>{view.note}</div>}
    </div>;
  }

  if (view.kind === "cover") {
    return <div className={styles.resultCard}>
      <div className={styles.resultHead}>
        <span className={styles.resultTitle}>产品封面</span>
        <span className={styles.resultBadge} data-ok={view.written || undefined}>{view.written ? "已写入" : "无需改写"}</span>
      </div>
      {view.imageCount > 0 && <div className={styles.resultRow}>
        <span className={styles.resultKey}>图片</span>
        <span className={styles.resultValue}>{view.imageCount} 张</span>
      </div>}
    </div>;
  }

  if (view.kind === "text") return <div className={styles.resultText}>{view.text}</div>;

  return <details className={styles.resultRaw}>
    <summary>查看原始数据</summary>
    <pre>{JSON.stringify(view.value, null, 2)}</pre>
  </details>;
}
