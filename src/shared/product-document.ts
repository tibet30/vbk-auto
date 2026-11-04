import type { ProductForm } from './product-form.js';

export type DocumentChatMessage = { role: 'user' | 'assistant'; content: string };
export type DocumentBrief = { destination: string; productForm: ProductForm | ''; days: number | null; userIdea: string };
export type DocumentChatRequest = { documentText: string; messages: DocumentChatMessage[]; brief: DocumentBrief };
export type DocumentChatResult = { reply: string; brief: DocumentBrief };
export type DocumentExtraction = { name: string; text: string };
