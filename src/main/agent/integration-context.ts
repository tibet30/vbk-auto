import type { AgentSnapshot, PlannerContext, ProductDetail } from '../../shared/contracts.js';
import type { VbkDatabase } from '../infrastructure/database/database.js';
import { isProductForm } from '../../shared/product-form.js';
import type { MemoryPromptContext } from '../../shared/contracts.js';
import { buildAgentProductContext, buildAgentTaskContext } from './prompt-context.js';
import { extractLockedConstraints, filterPlanningRequirementMessages } from './prompt-helpers.js';

export function agentPlannerContext(
  product: ProductDetail,
  providerLabel: string,
  model: string,
  messages: Array<{role:'user'|'assistant';content:string}> = [],
  memoryContext?: MemoryPromptContext,
): PlannerContext {
  const data = product.product as Record<string, unknown>;
  const basic = data.basicInfo as Record<string, unknown>;
  const sales = data.sales as Record<string, unknown>;
  const days = Number(basic.days);
  if (!Number.isInteger(days) || days < 1 || !isProductForm(sales.productForm)) throw new Error('产品骨架不完整，请先补全目的地、天数和产品形态。');
  const currentProduct = structuredClone(data);
  const planningMessages = filterPlanningRequirementMessages(messages);
  // The original persisted user idea stays intact. Later control messages are
  // not planning requirements and must not be concatenated into userIdea.
  (currentProduct.basicInfo as Record<string, unknown>).userIdea = [basic.userIdea, ...planningMessages.map((message) => message.content)].filter(Boolean).join('\n');
  return {
    skeleton: {
      destination: String(basic.meetingCity || basic.destinationCity || ''), days, nights: Number(basic.nights ?? days - 1),
      productForm: sales.productForm, productType: sales.productType === 'domesticLong' ? 'domesticLong' : 'domesticShort',
      supplierProductCode: String(basic.supplierProductCode ?? ''),
    },
    currentProduct, acceptedModules: [], existingResearchTasks: product.researchTasks.map(({label,type})=>({label,type})),
    history: planningMessages,
    lockedConstraints: extractLockedConstraints(product, messages),
    memoryContext: memoryContext?.lines.length ? memoryContext : undefined,
    transport: { providerLabel, model },
  };
}

/** Do not nest the conversation or automation logs back into a tool result. */
export function agentProductContext(product: ProductDetail, snapshot?: AgentSnapshot) {
  return buildAgentProductContext(product, snapshot);
}

export function agentTaskContext(db: VbkDatabase, id: string, memoryContext?: MemoryPromptContext): string {
  const product = db.getProduct(id);
  if (!product) throw new Error('产品不存在');
  return buildAgentTaskContext(product, db.getAgentSnapshot?.(id), memoryContext);
}
