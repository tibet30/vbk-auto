import { CircleAlert, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TibetPlatformReferenceResult } from "../../../../../shared/contracts.js";
import { api } from "../../../helpers";
import styles from "./platform-reference.module.less";

const COLLAPSE_KEY = "review-summary.platform-reference.collapsed";

function moneyExact(value: number | null): string {
  return typeof value === "number" ? `¥${value}` : "价格未标注";
}

function gapLabel(gap: number | null): string {
  if (typeof gap !== "number") return "";
  if (gap === 0) return "与产品同价";
  return gap > 0 ? `比产品高 ¥${gap}` : `比产品低 ¥${Math.abs(gap)}`;
}

/**
 * 产品审查面板里的「平台在售参考」。
 *
 * 只读比对：按产品标题与城市，在三人同游平台在售目录里找相近服务与起价。
 * 结果**不参与**程序检查与运营确认，也不写回产品事实——卡片文案里必须说清楚这一点，
 * 避免运营把参考价当成人审核结论。
 */
export function PlatformReferenceCard({ productId }: { productId: string }) {
  const [data, setData] = useState<TibetPlatformReferenceResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(COLLAPSE_KEY) === "1");

  const load = useCallback(async () => {
    const bridge = api();
    if (!bridge?.tibet) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      setData(await bridge.tibet.platformReference(productId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "平台参考查询失败。");
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => { void load(); }, [load]);

  const toggle = () => {
    setCollapsed((previous) => {
      const next = !previous;
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  return <section className={styles.card} aria-labelledby="platform-reference-title">
    <header className={styles.head}>
      <button type="button" className={styles.toggle} onClick={toggle} aria-expanded={!collapsed}>
        <Sparkles size={14} aria-hidden="true" />
        <span id="platform-reference-title">平台在售参考</span>
        {data ? <small>{data.matches.length ? `${data.matches.length} 条相近` : "无命中"}</small> : null}
      </button>
      <button type="button" className={styles.refresh} onClick={() => void load()} disabled={loading} aria-label="重新比对平台在售服务">
        {loading ? <LoaderCircle size={13} className={styles.spinner} /> : <RefreshCw size={13} />}
      </button>
    </header>

    {collapsed ? null : <div className={styles.body}>
      {error
        ? <p className={styles.status} data-tone="danger" role="alert"><CircleAlert size={13} />{error}</p>
        : null}

      {!error && loading && !data
        ? <p className={styles.status}><LoaderCircle size={13} className={styles.spinner} />正在比对平台在售服务…</p>
        : null}

      {!error && data && !data.matches.length
        ? <p className={styles.status}>{data.message}</p>
        : null}

      {data && data.matches.length
        ? <ul className={styles.list}>
          {data.matches.map((match) => <li key={match.publicId}>
            <div className={styles.row}>
              <strong title={match.title}>{match.title}</strong>
              <span className={styles.price}>{moneyExact(match.priceFrom)}</span>
            </div>
            <div className={styles.meta}>
              {match.cityName || match.cityCode || "城市未知"}
              {match.durationLabel ? ` · ${match.durationLabel}` : ""}
              {typeof match.priceGap === "number" ? ` · ${gapLabel(match.priceGap)}` : ""}
            </div>
            <div className={styles.meta}>{match.reasons.join("，")} · public_id {match.publicId}</div>
          </li>)}
        </ul>
        : null}

      <p className={styles.footnote}>仅供参考：不参与程序检查与运营确认，也不会写入产品。</p>
    </div>}
  </section>;
}
