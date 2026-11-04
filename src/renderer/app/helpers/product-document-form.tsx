import { useRef, useState } from 'react';
import { FileText, LoaderCircle, Upload } from 'lucide-react';
import type { CreateProductInput } from '../../../shared/contracts.js';
import type { DocumentBrief, DocumentChatMessage } from '../../../shared/product-document.js';
import { PRODUCT_FORM_LABELS, type ProductForm } from '../../../shared/product-form.js';
import { api } from './constants.js';
import { Select } from './Select.js';
import { validateProductBrief } from './product-brief-validation.js';
import { ProductCreateModeSwitch, type ProductCreateMode } from './product-create-mode-switch.js';
import { ProductDocumentChat } from './product-document-chat.js';
import shared from '../views/shared.module.less';
import styles from './product-document-form.module.less';

type Props = { submitting: boolean; mode: ProductCreateMode; onModeChange: (mode: ProductCreateMode) => void; onCancel: () => void; onSubmit: (input: CreateProductInput) => void };
const emptyBrief: DocumentBrief = { destination: '', productForm: '', days: null, userIdea: '' };
const IDEA_MAX = 1000;

/** Electron 把主进程异常包装成 `Error invoking remote method 'x': Error: ...`，只展示业务文案。 */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method\s+['"][^'"]+['"]:\s*(?:Error:\s*)?/i;
function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return raw.replace(REMOTE_METHOD_PREFIX, '').trim() || fallback;
}

export function ProductDocumentForm({ submitting, mode, onModeChange, onCancel, onSubmit }: Props) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [brief, setBrief] = useState<DocumentBrief>(emptyBrief);
  const [messages, setMessages] = useState<DocumentChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [chatFailed, setChatFailed] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const lastSuggestedIdea = useRef('');
  const locked = busy || submitting;
  const update = (patch: Partial<DocumentBrief>) => { setBrief(current => ({ ...current, ...patch })); setReviewed(false); };

  const discuss = async (source: { name: string; text: string }, history: DocumentChatMessage[], current: DocumentBrief) => {
    if (history.length >= 60) { setError('本次对话已达到长度上限，请整理已有内容后创建。'); return false; }
    setBusy(true); setError(''); setChatFailed(false);
    try {
      const client = api(); if (!client) throw new Error('应用通道未就绪。');
      const result = await client.ai.document.discuss({ documentText: source.text, messages: history, brief: current });
      setMessages([...history, { role: 'assistant', content: result.reply }]);
      const previousSuggestion = lastSuggestedIdea.current;
      setBrief(latest => ({ ...result.brief, userIdea: latest.userIdea && latest.userIdea !== previousSuggestion ? latest.userIdea : result.brief.userIdea }));
      lastSuggestedIdea.current = result.brief.userIdea; setReviewed(false);
      return true;
    } catch (e) { setError(errorMessage(e, 'AI 处理失败，请重试。')); setChatFailed(history.length === 0); return false; }
    finally { setBusy(false); }
  };
  const upload = async (selected?: File) => {
    if (!selected) return;
    setBusy(true); setUploading(true); setError(''); setReviewed(false);
    let extracted: { name: string; text: string };
    try {
      if (selected.size > 10 * 1024 * 1024) throw new Error('文件不能超过 10 MB。');
      const client = api(); if (!client) throw new Error('应用通道未就绪。');
      extracted = await client.ai.document.extract(selected.name, new Uint8Array(await selected.arrayBuffer()));
    } catch (e) {
      setError(`${errorMessage(e, '读取文档失败，请重试。')}${file ? ' 当前仍保留上一份文档。' : ''}`);
      setBusy(false); setUploading(false); return;
    }
    setFile(extracted); setMessages([]); setBrief(emptyBrief); setQuestion(''); setAttempted(false); setChatFailed(false); lastSuggestedIdea.current = '';
    setUploading(false); setBusy(false);
    await discuss(extracted, [], emptyBrief);
  };
  const send = async () => {
    if (!file || busy || !question.trim()) return;
    const history: DocumentChatMessage[] = [...messages, { role: 'user', content: question.trim() }];
    const ok = await discuss(file, history, brief);
    if (ok) setQuestion(''); else setMessages(history);
  };

  const missing = { destination: !brief.destination.trim(), productForm: !brief.productForm, days: !brief.days };
  const create = () => {
    setAttempted(true);
    if (missing.destination || missing.productForm || missing.days) { setError('请补全标出的创建信息。'); return; }
    const input: CreateProductInput = { destination: brief.destination, productForm: brief.productForm as ProductForm, days: brief.days!, userIdea: brief.userIdea };
    const first = Object.values(validateProductBrief(input))[0];
    if (first) { setError(first); return; }
    if (!reviewed) { setError('请先勾选“我已核对以上创建信息”。'); return; }
    onSubmit(input);
  };
  const invalid = (field: keyof typeof missing) => attempted && missing[field];
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault(); setDragging(false);
    if (locked) return;
    if (event.dataTransfer.files.length !== 1) { setError('每次请选择一份文档。'); return; }
    void upload(event.dataTransfer.files[0]);
  };

  return <div className={`${shared.card} ${styles.documentForm}`}>
    <header className={styles.head}>
      <div><h3>从文档创建产品</h3><p>上传行程资料，与 AI 核对后创建；路线与服务仍需在创建后逐项确认。</p></div>
      <ProductCreateModeSwitch mode={mode} onChange={onModeChange} disabled={locked} />
    </header>
    <div className={styles.upload} data-dragging={dragging} data-has-file={Boolean(file)} data-disabled={locked}
      onDragOver={event => { event.preventDefault(); if (!locked) setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={onDrop}>
      {uploading ? <LoaderCircle size={20} className={styles.spin} aria-hidden="true" /> : file ? <FileText size={20} aria-hidden="true" /> : <Upload size={20} aria-hidden="true" />}
      <div className={styles.uploadContent}>
        <strong>{uploading ? '正在读取文档…' : file ? file.name : '上传行程文档'}</strong>
        <span className={styles.uploadHelp}>{file ? `已读取 ${file.text.length} 字 · 文字会发送给当前 AI 服务处理` : '拖放文件到这里，或点击右侧选择。支持可复制文字的 PDF 和 DOCX，最大 10 MB'}</span>
      </div>
      <label className={`${shared.btn} ${styles.uploadAction}`} data-variant="secondary" data-disabled={locked}>
        {file ? '更换文件' : '选择文件'}<input type="file" aria-label="选择行程文档" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={locked} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
      </label>
    </div>
    {file && <>
      <details className={styles.source}><summary>查看提取的文档文字</summary><pre>{file.text}</pre></details>
      <ProductDocumentChat messages={messages} question={question} busy={busy} failed={chatFailed} onQuestion={setQuestion} onSend={() => void send()} onStart={() => void discuss(file, [], brief)} />
      <section className={styles.brief} aria-label="创建信息">
        <div className={styles.briefHead}><h4>创建信息</h4><p>AI 的建议可直接修改；不明确的信息请继续讨论或自行填写。</p></div>
        <div className={styles.grid}>
          <label><span className={shared.fieldLabel}>接团城市 <i>必填</i></span><input className={shared.input} value={brief.destination} maxLength={100} disabled={locked} aria-invalid={invalid('destination')} onChange={e => update({ destination: e.target.value })} placeholder="例如：重庆" /></label>
          <label><span className={shared.fieldLabel}>产品形态 <i>必填</i></span><Select value={brief.productForm} disabled={locked} aria-invalid={invalid('productForm')} onChange={e => update({ productForm: e.target.value as ProductForm | '' })}><option value="">请选择</option>{Object.entries(PRODUCT_FORM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
          <label><span className={shared.fieldLabel}>天数 <i>必填</i></span><input className={shared.input} type="number" min={2} max={60} value={brief.days ?? ''} disabled={locked} aria-invalid={invalid('days')} placeholder="2–60" onChange={e => update({ days: e.target.value ? Number(e.target.value) : null })} /></label>
        </div>
        <label className={styles.idea}><span className={shared.fieldLabel}>规划想法 <i>选填</i></span><textarea className={shared.input} rows={7} maxLength={IDEA_MAX} value={brief.userIdea} disabled={locked} onChange={e => update({ userIdea: e.target.value })} /><span className={styles.count}>{brief.userIdea.length} / {IDEA_MAX} 字</span></label>
        <p className={styles.hint}>创建时只保存接团城市、产品形态、天数和规划想法；对话与文档原文不会保存，请把需要保留的要求写进规划想法。</p>
        <label className={styles.confirm}><input type="checkbox" checked={reviewed} disabled={locked} onChange={e => setReviewed(e.target.checked)} />我已核对以上创建信息</label>
      </section>
    </>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <footer>
      <button type="button" className={shared.btn} data-variant="ghost" onClick={onCancel} disabled={locked}>取消</button>
      <button type="button" className={shared.btn} data-variant="primary" disabled={!file || locked} onClick={create}>{submitting ? <><LoaderCircle size={14} className={styles.spin} />创建中</> : '确认并创建'}</button>
    </footer>
  </div>;
}
