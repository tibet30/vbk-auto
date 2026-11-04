import { useEffect, useRef } from 'react';
import { LoaderCircle, RotateCcw, Send, Sparkles } from 'lucide-react';
import type { DocumentChatMessage } from '../../../shared/product-document.js';
import shared from '../views/shared.module.less';
import styles from './product-document-form.module.less';

type Props = {
  messages: DocumentChatMessage[]; question: string; busy: boolean; failed: boolean;
  onQuestion: (value: string) => void; onSend: () => void; onStart: () => void;
};

/** 与 AI 的整理对话：首轮未成功时给出明确的重试入口，成功后才出现输入框。 */
export function ProductDocumentChat({ messages, question, busy, failed, onQuestion, onSend, onStart }: Props) {
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages.length, busy]);
  return <section className={styles.chatSection} aria-label="与 AI 整理创建信息">
    <div className={styles.chat} ref={log} aria-live="polite">
      {messages.length === 0 && !busy && <div className={styles.chatEmpty}>
        <Sparkles size={16} aria-hidden="true" />
        <p>{failed ? 'AI 整理没有成功，文档已保留，可重试。' : 'AI 会读取文档，提出创建信息和需要你确认的问题。'}</p>
        <button type="button" className={shared.btn} data-variant="ai" onClick={onStart}>{failed ? <><RotateCcw size={14} />重试整理</> : <><Sparkles size={14} />开始整理</>}</button>
      </div>}
      {messages.map((message, index) => <div key={index} className={styles.message} data-role={message.role}><span>{message.role === 'user' ? '你' : 'AI'}</span><p>{message.content}</p></div>)}
      {busy && <div className={styles.thinking} role="status"><LoaderCircle size={14} className={styles.spin} aria-hidden="true" />AI 正在整理…</div>}
    </div>
    {messages.length > 0 && <div className={styles.composer}>
      <textarea className={shared.input} aria-label="向 AI 补充或提问" placeholder="补充要求、回答问题或继续讨论…（⌘/Ctrl + 回车发送）" maxLength={4000} value={question} disabled={busy}
        onChange={event => onQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); onSend(); } }} />
      <button type="button" className={shared.btn} data-variant="primary" disabled={busy || !question.trim()} onClick={onSend}><Send size={14} />发送</button>
    </div>}
  </section>;
}
