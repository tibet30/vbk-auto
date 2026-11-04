import styles from './product-create-mode-switch.module.less';

export type ProductCreateMode = 'manual' | 'document';

type Props = { mode: ProductCreateMode; onChange: (mode: ProductCreateMode) => void; disabled?: boolean };

/** 手工填写 / 从文档创建 的统一切换，两种表单共用，位置固定在卡片右上角。 */
export function ProductCreateModeSwitch({ mode, onChange, disabled }: Props) {
  const options: Array<[ProductCreateMode, string]> = [['manual', '手工填写'], ['document', '从文档创建']];
  return <div className={styles.switch} role="group" aria-label="创建方式">
    {options.map(([value, label]) => <button key={value} type="button" className={styles.option} aria-pressed={mode === value} disabled={disabled && mode !== value} onClick={() => mode !== value && onChange(value)}>{label}</button>)}
  </div>;
}
