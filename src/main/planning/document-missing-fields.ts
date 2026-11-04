import type { DocumentBrief } from '../../shared/product-document.js';
import { PRODUCT_FORM_LABELS } from '../../shared/product-form.js';

/** 必填项缺失时的固定追问；不含模型自由文本，避免把推断说成已确认。 */
export function missingFieldsPrompt(brief: DocumentBrief): string {
  const missing = [
    brief.destination.trim() ? '' : '接团城市',
    brief.productForm ? '' : `产品形态（${Object.values(PRODUCT_FORM_LABELS).join('/')}）`,
    brief.days ? '' : '天数',
  ].filter(Boolean);
  if (!missing.length) return '';
  const example = ['奉节接团', '跟团游'].slice(brief.destination.trim() ? 1 : 0, brief.productForm ? 1 : 2).join('，');
  return `\n还需要你确认：${missing.join('、')}。${example ? `直接回复即可，例如“${example}”。` : ''}`;
}
