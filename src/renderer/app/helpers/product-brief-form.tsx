import { Select } from "./Select";
import { Check, LoaderCircle, Plus, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CreateProductInput, ProductIdeaOptimizationRequest, ProductIdeaOptimizationResult } from "../../../shared/contracts.js";
import { PRODUCT_FORM_LABELS, type ProductForm } from "../../../shared/product-form.js";
import shared from "../views/shared.module.less";
import styles from "./components.module.less";
import ideaStyles from "./product-brief-form.module.less";
import { api } from "./constants.js";
import { type ProductBriefField, type ProductBriefFieldErrors, validateProductBrief } from "./product-brief-validation";
import { CREATE_PRODUCT_MAX_DAYS, CREATE_PRODUCT_MIN_DAYS, parseProductDaysInput, productDaysInputValue } from "./product-days-input";

type Props = { input: CreateProductInput; setInput: (input: CreateProductInput) => void; autoConfirm: boolean; setAutoConfirm: (value: boolean) => void; submitting: boolean; onCancel: () => void; onSubmit: () => void };
type OptimizationSource = ProductIdeaOptimizationRequest;

export function ProductBriefForm({ input, setInput, submitting, onCancel, onSubmit }: Props) {
  const [fieldErrors, setFieldErrors] = useState<ProductBriefFieldErrors>({});
  const [sourceIdea, setSourceIdea] = useState(input.userIdea ?? "");
  const [result, setResult] = useState<ProductIdeaOptimizationResult | null>(null);
  const [resultSource, setResultSource] = useState<OptimizationSource | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizationError, setOptimizationError] = useState<string | null>(null);
  const [adopted, setAdopted] = useState(false);
  const ideaRef = useRef<HTMLTextAreaElement>(null);
  const ideaComposingRef = useRef(false);
  const requestSequence = useRef(0);
  useEffect(() => () => { requestSequence.current += 1; }, []);

  const stale = Boolean(resultSource && (resultSource.destination !== input.destination.trim()
    || resultSource.days !== input.days || resultSource.productForm !== input.productForm
    || resultSource.userIdea !== sourceIdea.trim()));
  const canOptimize = !optimizing && !submitting && sourceIdea.trim().length > 0
    && Object.keys(validateProductBrief({ ...input, userIdea: sourceIdea })).length === 0;

  const updateBase = (field: ProductBriefField, next: CreateProductInput) => {
    const reverted = adopted ? { ...next, userIdea: sourceIdea, ideaOptimization: undefined } : { ...next, ideaOptimization: undefined };
    if (adopted) setAdopted(false);
    setInput(reverted);
    if (fieldErrors[field]) setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };
  const updateSourceIdea = (userIdea: string) => {
    setSourceIdea(userIdea);
    if (adopted) setAdopted(false);
    setInput({ ...input, userIdea, ideaOptimization: undefined });
    if (fieldErrors.userIdea) setFieldErrors((current) => ({ ...current, userIdea: undefined }));
  };

  const optimize = async () => {
    const request: OptimizationSource = { destination: input.destination.trim(), days: input.days, productForm: input.productForm, userIdea: sourceIdea.trim() };
    const errors = validateProductBrief({ ...input, userIdea: request.userIdea });
    if (!request.userIdea) errors.userIdea = "请先填写想法，再让 AI 优化。";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const client = api();
    if (!client) { setOptimizationError("AI 通道未就绪，请稍后重试。"); return; }
    const sequence = ++requestSequence.current;
    setOptimizing(true); setOptimizationError(null);
    try {
      const next = await client.ai.optimizeProductIdea(request);
      if (sequence !== requestSequence.current) return;
      setResult(next); setResultSource(request); setAdopted(false);
    } catch (error) {
      if (sequence === requestSequence.current) setOptimizationError(error instanceof Error ? error.message : "AI 优化失败，请重试。");
    } finally {
      if (sequence === requestSequence.current) setOptimizing(false);
    }
  };

  const adopt = () => {
    if (!result || !resultSource || stale) return;
    setAdopted(true);
    setInput({ ...input, userIdea: result.optimizedIdea, ideaOptimization: { ...result, originalIdea: resultSource.userIdea } });
  };
  const submit = () => {
    const errors = validateProductBrief(input); setFieldErrors(errors);
    if (Object.keys(errors).length === 0) onSubmit();
  };

  return <div className={`${shared.card} ${styles.briefForm}`}>
    <div><h3>新建产品</h3><p className={shared.viewSub}>填写基础信息和你的初步想法，也可以先让 AI 整理成更可执行的规划输入。</p></div>
    <div className={styles.briefGrid}>
      <label><span className={shared.fieldLabel}>目的地</span><input className={shared.input} autoFocus placeholder="例如：太原" value={input.destination} aria-invalid={Boolean(fieldErrors.destination)} aria-describedby={fieldErrors.destination ? "create-product-destination-error" : undefined} onChange={(event) => updateBase("destination", { ...input, destination: event.target.value })} />{fieldErrors.destination ? <span id="create-product-destination-error" className={styles.fieldError} role="alert">{fieldErrors.destination}</span> : null}</label>
      <label><span className={shared.fieldLabel}>产品形态</span><Select value={input.productForm} onChange={(event) => updateBase("userIdea", { ...input, productForm: event.target.value as CreateProductInput["productForm"] })}>{(Object.entries(PRODUCT_FORM_LABELS) as Array<[ProductForm, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
      <label><span className={shared.fieldLabel}>天数</span><input className={shared.input} type="number" min={CREATE_PRODUCT_MIN_DAYS} max={CREATE_PRODUCT_MAX_DAYS} value={productDaysInputValue(input.days)} aria-invalid={Boolean(fieldErrors.days)} aria-describedby={fieldErrors.days ? "create-product-days-error" : undefined} onChange={(event) => updateBase("days", { ...input, days: parseProductDaysInput(event.target.value) })} />{fieldErrors.days ? <span id="create-product-days-error" className={styles.fieldError} role="alert">{fieldErrors.days}</span> : null}</label>
    </div>
    <div className={ideaStyles.ideaHeader}>
      <div><span className={shared.fieldLabel}>{result ? "原版与 AI 版本" : "你的想法"} <small>选填</small></span><p>AI 会保留核心要求，调整次要安排；确认后，创建内容将直接使用 AI 版本。</p></div>
      <button type="button" className={shared.btn} data-variant="secondary" disabled={!canOptimize} onClick={() => void optimize()}>{optimizing ? <><LoaderCircle size={14} className={styles.spin} />正在优化</> : result ? <><RotateCcw size={14} />重新优化</> : <><Sparkles size={14} />AI 优化想法</>}</button>
    </div>
    <div className={result ? ideaStyles.ideaCompare : undefined}>
      <label className={styles.ideaField}>
        {result ? <span className={ideaStyles.columnLabel}>原版</span> : null}
        <textarea ref={ideaRef} className={shared.input} rows={result ? 9 : 5} maxLength={1000} placeholder="例如：希望节奏慢一点，多安排当地文化体验，适合带孩子出行……" defaultValue={sourceIdea} onCompositionStart={() => { ideaComposingRef.current = true; }} onCompositionEnd={(event) => { ideaComposingRef.current = false; updateSourceIdea(event.currentTarget.value.slice(0, 1000)); }} onChange={(event) => { if (!ideaComposingRef.current) updateSourceIdea(event.target.value.slice(0, 1000)); }} aria-invalid={Boolean(fieldErrors.userIdea)} aria-describedby={fieldErrors.userIdea ? "create-product-idea-error" : "product-idea-hint"} />
        {fieldErrors.userIdea ? <span id="create-product-idea-error" className={styles.fieldError} role="alert">{fieldErrors.userIdea}</span> : null}
        <span id="product-idea-hint" className={styles.ideaHint}>{sourceIdea.length} / 1000 字</span>
      </label>
      {result ? <label className={styles.ideaField}>
        <span className={ideaStyles.columnLabel}>AI 版本</span>
        <textarea className={shared.input} rows={9} value={result.optimizedIdea} readOnly aria-label="AI 版本" />
        <span className={styles.ideaHint}>{result.optimizedIdea.length} / 1000 字</span>
      </label> : null}
    </div>
    {optimizationError ? <div className={ideaStyles.errorNotice} role="alert"><TriangleAlert size={15} /><span>{optimizationError}</span><button type="button" onClick={() => void optimize()}>重试</button></div> : null}
    {result ? <OptimizationReview result={result} stale={stale} adopted={adopted} onAdopt={adopt} /> : null}
    {input.productForm === "privateTour" ? <span className={styles.ideaGuide}>建议补充：付费景点及门票是否包含、特色体验、适合客群、游览节奏和已确认服务。私家团副标题固定包含“一单一团+24h线上管家”。</span> : null}
    <p className={styles.ideaHint}>创建后仍会经过程序检查和你的方案确认，AI 优化不会直接进入 VBK 录入。</p>
    <div className={styles.formActions}><button type="button" className={shared.btn} data-variant="ghost" onClick={onCancel}>取消</button><button type="button" className={shared.btn} data-variant="primary" disabled={submitting} onClick={submit}>{submitting ? <><LoaderCircle size={15} className={styles.spin} />创建中</> : <><Plus size={15} />创建</>}</button></div>
  </div>;
}

function OptimizationReview({ result, stale, adopted, onAdopt }: { result: ProductIdeaOptimizationResult; stale: boolean; adopted: boolean; onAdopt: () => void }) {
  return <section className={ideaStyles.review} aria-label="AI 优化变化">
    {stale ? <p className={ideaStyles.stale} role="status"><TriangleAlert size={14} />输入已变化，请重新优化后再采用。旧结果保留供参考。</p> : null}
    <div className={ideaStyles.changeGrid}>
      <ChangeGroup title="已保留" items={result.preservedItems} empty="核心要求已保留在优化稿中" />
      <ChangeGroup title="已调整" items={result.changes.map((item) => `${item.before} → ${item.after}（${item.reason}）`)} empty="没有实质调整" />
      <ChangeGroup title="新增建议" items={result.recommendations} empty="没有新增建议" />
      <ChangeGroup title="待留意" items={result.warnings} empty="未发现明显冲突" />
    </div>
    <div className={ideaStyles.reviewActions}><span>{adopted ? <><Check size={14} />已使用 AI 版本，创建后将始终以此为准</> : "确认前仍使用原版；确认后 AI 版本会覆盖创建内容"}</span><button type="button" className={shared.btn} data-variant="primary" disabled={stale || adopted} onClick={onAdopt}>{adopted ? "已使用 AI 版本" : "使用 AI 版本"}</button></div>
  </section>;
}

function ChangeGroup({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <div><strong>{title}</strong>{items.length ? <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul> : <p>{empty}</p>}</div>;
}
