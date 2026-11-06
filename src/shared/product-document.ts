import type { ProductForm } from './product-form.js';

export type DocumentChatMessage = { role: 'user' | 'assistant'; content: string };
export type DocumentBrief = { destination: string; productForm: ProductForm | ''; days: number | null; userIdea: string };
export type DocumentChatRequest = { documentText: string; messages: DocumentChatMessage[]; brief: DocumentBrief };
export type DocumentMeal = '早餐' | '午餐' | '晚餐';
/** 文档逐日安排的规范结构：规划想法由它渲染，名称全部逐字取自文档。 */
export type DocumentDayPlan = { day: number; route: string; spots: string[]; meals: DocumentMeal[]; lodging: string[] };
export type DocumentChatResult = { reply: string; brief: DocumentBrief; itinerary?: DocumentDayPlan[] };
export type DocumentExtraction = { name: string; text: string };
