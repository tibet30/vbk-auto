import React, { memo, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import styles from "./message-markdown.module.less";

/**
 * 助手文本的统一渲染入口：解析交给 react-markdown + remark-gfm，
 * 本文件只负责把 GFM 的能力接到设计令牌上，不再手写任何语法解析。
 *
 * - GFM：表格、删除线、任务列表、自动链接。
 * - remark-breaks：单换行按 <br> 处理，与模型逐行输出订单/清单的习惯一致。
 */

/** 宽表在窄面板内横向滚动；表格本身仍由 react-markdown 生成。 */
function Table({ children }: Pick<ComponentProps<"table">, "children">) {
  return <div className={styles.tableScroll}><table>{children}</table></div>;
}

/** 外链一律新窗口打开，由主进程转交系统浏览器，避免应用窗口被导航走。 */
function Anchor({ href, children, title }: Pick<ComponentProps<"a">, "children" | "href" | "title">) {
  return <a href={href} title={title} target="_blank" rel="noreferrer noopener">{children}</a>;
}

const MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];
const MARKDOWN_COMPONENTS = { table: Table, a: Anchor };

export interface MessageMarkdownProps {
  content: string;
  /** 外层附加类（例如中断态），由调用方决定。 */
  className?: string;
  /** 流式输出中：末尾显示跟随光标。 */
  streaming?: boolean;
}

export const MessageMarkdown = memo(function MessageMarkdown({ content, className, streaming }: MessageMarkdownProps) {
  const classes = [styles.markdown, className].filter(Boolean).join(" ");
  return <div className={classes} data-streaming={streaming || undefined}>
    <Markdown remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS}>{content}</Markdown>
  </div>;
});
