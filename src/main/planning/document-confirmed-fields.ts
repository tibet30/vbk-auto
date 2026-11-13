import type { DocumentChatRequest, DocumentChatResult } from '../../shared/product-document.js';
import { PRODUCT_FORM_LABELS } from '../../shared/product-form.js';

/**
 * 合并文档分析结果与运营手填值。
 *
 * 接团城市必须能在文档原文中核对，或由运营明确指定；产品形态允许模型根据
 * 行程服务特征分析。已有表单值与运营后续明确修改始终优先，避免重复讨论覆盖手填内容。
 */
export function protectDocumentFields(input: DocumentChatRequest, result: DocumentChatResult): DocumentChatResult {
  const userText = input.messages.filter(message => message.role === 'user').map(message => message.content).join('。');
  const sentences = userText.split(/(?<=[。；;\n！？!?])/u);
  const uncertain = /[?？]|(?:未确认|待确认|不确定|还未|是否|可能|也许|大概|或者|还是|建议|猜测|什么|吗)/u;
  // 只从独立肯定短句提取，避免同一条消息中的其他待确认事项污染已确认字段。
  const clauses = input.messages.filter(message => message.role === 'user')
    .flatMap(message => message.content.split(/[。；;\n]/u))
    .filter(sentence => !/[?？]/u.test(sentence))
    .flatMap(sentence => sentence.split(/[，,、]/u).map(part => part.trim()))
    .filter(part => !uncertain.test(part) && !/^(?:不|没|非|未|无)/u.test(part));
  const explicitCity = [...clauses].reverse().map(part => part.match(/^([\p{Script=Han}]{2,8}?)接团$/u)?.[1] ?? '')
    .find(value => value && !/^(?:不|没|非|未|无)/u.test(value));
  const explicitForm = [...clauses].reverse().map(part => Object.entries(PRODUCT_FORM_LABELS).find(([, value]) => value === part)?.[0])
    .find(Boolean) as DocumentChatResult['brief']['productForm'] | undefined;
  const city = result.brief.destination.trim();
  const form = result.brief.productForm;
  const confirmedCity = city && sentences.some(sentence => sentence.includes(city)
    && /接团城市|集合城市|接团地|接团/u.test(sentence)
    && /确认|确定|(?:为|是|选|用)/u.test(sentence)
    && !uncertain.test(sentence) && !/不是|不要|不能/u.test(sentence));
  const label = form ? PRODUCT_FORM_LABELS[form] : '';
  const directFormAnswer = Boolean(label && input.messages.some((message, index) => message.role === 'user'
    && message.content.trim() === label && input.messages[index - 1]?.role === 'assistant'
    && /产品形态|产品类型/u.test(input.messages[index - 1]!.content)));
  const confirmedForm = directFormAnswer || Boolean(label && sentences.some(sentence => sentence.includes(label)
    && /产品形态|产品类型|确认|确定|选择|做成|作为/u.test(sentence)
    && !new RegExp(`(?:不|不要|不是|不选|不能|排除|待确认|未确认)[^，,。；;]{0,12}${label}`, 'u').test(sentence)
    && !uncertain.test(sentence)));
  const rejectedForm = Boolean(label && new RegExp(`(?:不|不要|不是|不选|不能|排除)[^，,。；;]{0,12}${label}`, 'u').test(userText));
  const source = input.documentText.replace(/\s+/gu, '');
  const citySupported = Boolean(city && source.includes(city.replace(/\s+/gu, '')));
  const destination = explicitCity || (confirmedCity ? city : input.brief.destination || (citySupported ? city : ''));
  const productForm = explicitForm || (confirmedForm ? form : input.brief.productForm || (rejectedForm ? '' : form));
  const discarded = Boolean((city && destination !== city) || (form && productForm !== form));
  return {
    reply: discarded ? '部分创建信息无法从文档原文核对，已保留可验证的建议；请核对下方内容，需要调整可直接修改。' : result.reply,
    brief: { ...result.brief, destination, productForm },
  };
}
