import { LoaderCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CreateProductInput } from "../../../shared/contracts.js";
import { PRODUCT_FORM_LABELS, type ProductForm } from "../../../shared/product-form.js";
import shared from "../views/shared.module.less";
import styles from "./components.module.less";
import { type ProductBriefField, type ProductBriefFieldErrors, validateProductBrief } from "./product-brief-validation";
import { CREATE_PRODUCT_MAX_DAYS, CREATE_PRODUCT_MIN_DAYS, parseProductDaysInput, productDaysInputValue } from "./product-days-input";

export function ProductBriefForm({ input, setInput, autoConfirm, setAutoConfirm, submitting, onCancel, onSubmit }: { input: CreateProductInput; setInput: (input: CreateProductInput) => void; autoConfirm: boolean; setAutoConfirm: (value: boolean) => void; submitting: boolean; onCancel: () => void; onSubmit: () => void }) {
  const [fieldErrors, setFieldErrors] = useState<ProductBriefFieldErrors>({});
  const [ideaDraft, setIdeaDraft] = useState(input.userIdea ?? "");
  const ideaRef = useRef<HTMLTextAreaElement>(null);
  const ideaComposingRef = useRef(false);
  const updateInput = (field: ProductBriefField, nextInput: CreateProductInput) => {
    setInput(nextInput);
    if (fieldErrors[field]) setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };
  useEffect(() => {
    if (ideaComposingRef.current) return;
    const nextIdea = input.userIdea ?? "";
    setIdeaDraft((current) => current === nextIdea ? current : nextIdea);
    if (ideaRef.current && ideaRef.current.value !== nextIdea) ideaRef.current.value = nextIdea;
  }, [input.userIdea]);
  const submit = () => {
    const errors = validateProductBrief(input);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    onSubmit();
  };
  return <div className={`${shared.card} ${styles.briefForm}`}>
    <div><h3>新建产品</h3><p className={shared.viewSub}>填写基础信息和你的初步想法，进入产品后 AI 会据此开始规划。</p></div>
    <div className={styles.briefGrid}>
      <label><span className={shared.fieldLabel}>目的地</span><input className={shared.input} autoFocus placeholder="例如：太原" value={input.destination} aria-invalid={Boolean(fieldErrors.destination)} aria-describedby={fieldErrors.destination ? "create-product-destination-error" : undefined} onChange={(event) => updateInput("destination", { ...input, destination: event.target.value })} />{fieldErrors.destination ? <span id="create-product-destination-error" className={styles.fieldError} role="alert">{fieldErrors.destination}</span> : null}</label>
      <label><span className={shared.fieldLabel}>产品形态</span><select className={shared.input} value={input.productForm} onChange={(event) => setInput({ ...input, productForm: event.target.value as CreateProductInput["productForm"] })}>{(Object.entries(PRODUCT_FORM_LABELS) as Array<[ProductForm, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span className={shared.fieldLabel}>天数</span><input className={shared.input} type="number" min={CREATE_PRODUCT_MIN_DAYS} max={CREATE_PRODUCT_MAX_DAYS} value={productDaysInputValue(input.days)} aria-invalid={Boolean(fieldErrors.days)} aria-describedby={fieldErrors.days ? "create-product-days-error" : undefined} onChange={(event) => updateInput("days", { ...input, days: parseProductDaysInput(event.target.value) })} />{fieldErrors.days ? <span id="create-product-days-error" className={styles.fieldError} role="alert">{fieldErrors.days}</span> : null}</label>
    </div>
    <label className={styles.ideaField}>
      <span className={shared.fieldLabel}>你的想法 <small>选填</small></span>
      <textarea ref={ideaRef} className={shared.input} rows={5} maxLength={1000} placeholder="例如：希望节奏慢一点，多安排当地文化体验，适合带孩子出行……" defaultValue={input.userIdea ?? ""} onCompositionStart={() => { ideaComposingRef.current = true; }} onCompositionEnd={(event) => { ideaComposingRef.current = false; const userIdea = event.currentTarget.value.slice(0, 1000); setIdeaDraft(userIdea); updateInput("userIdea", { ...input, userIdea }); }} onChange={(event) => { const userIdea = event.target.value.slice(0, 1000); if (ideaComposingRef.current) return; setIdeaDraft(userIdea); updateInput("userIdea", { ...input, userIdea }); }} aria-invalid={Boolean(fieldErrors.userIdea)} aria-describedby={fieldErrors.userIdea ? "create-product-idea-error" : "product-idea-hint"} />
      {fieldErrors.userIdea ? <span id="create-product-idea-error" className={styles.fieldError} role="alert">{fieldErrors.userIdea}</span> : null}
      <span id="product-idea-hint" className={styles.ideaHint}>{ideaDraft.length} / 1000 字，AI 会把它作为需求偏好参考</span>
    </label>
    <label className={styles.autoConfirmOption}>
      <input type="checkbox" checked={autoConfirm} disabled={submitting} onChange={(event) => setAutoConfirm(event.target.checked)} />
      <span><strong>一键生成并录入携程</strong><small>跳过人工确认；仅在方案通过自动核验后才会写入 VBK。</small></span>
    </label>
    <div className={styles.formActions}>
      <button className={shared.btn} data-variant="ghost" onClick={onCancel}>取消</button>
      <button className={shared.btn} data-variant="primary" disabled={submitting} onClick={submit}>
        {submitting ? <><LoaderCircle size={15} className={styles.spin} />{autoConfirm ? "正在创建后台任务…" : "创建中"}</> : <><Plus size={15} />创建</>}
      </button>
    </div>
  </div>;
}
