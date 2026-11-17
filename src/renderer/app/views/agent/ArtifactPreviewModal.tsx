import React, { useEffect } from "react";
import { ExternalLink, X } from "lucide-react";
import styles from "./artifact-preview.module.less";

/**
 * 应用内网页产物预览。
 *
 * 内容来自主进程内联后的 HTML（样式已内联、不含脚本），这里只用 `sandbox=""`
 * 的 iframe 承载：不执行脚本、不给同源权限，模型生成的页面无法碰到应用。
 */
export function ArtifactPreviewModal(props: {
  title: string;
  html?: string;
  loading: boolean;
  error?: string;
  truncated?: boolean;
  onClose(): void;
  onOpenInBrowser?(): void;
}) {
  const { title, html, loading, error, truncated, onClose, onOpenInBrowser } = props;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`预览 ${title}`}>
      <section className={styles.panel}>
        <header className={styles.head}>
          <div className={styles.titleBlock}>
            <h2>{title}</h2>
            <p>只渲染静态内容：样式已内联，脚本不会执行。</p>
          </div>
          {onOpenInBrowser && (
            <button type="button" className={styles.secondary} onClick={onOpenInBrowser}>
              <ExternalLink size={13} />用浏览器打开
            </button>
          )}
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭预览">
            <X size={15} />
          </button>
        </header>
        {loading && <p className={styles.hint}>正在读取产物…</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {truncated && <p className={styles.hint}>内容过大，已截断显示。</p>}
        {html !== undefined && !error && (
          <iframe
            className={styles.frame}
            title={`${title} 预览`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={html}
          />
        )}
      </section>
    </div>
  );
}
