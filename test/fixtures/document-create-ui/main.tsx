import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ProductBriefForm } from '../../../src/renderer/app/helpers/product-brief-form';
import type { CreateProductInput } from '../../../src/shared/contracts';
import '../../../src/renderer/styles/reset.css';
import '../../../src/renderer/styles/tokens.css';
import '../../../src/renderer/styles/global.css';

window.vbk = { ai: { document: {
  extract: async (name: string) => ({ name, text: '第一天三峡之巅，第二天游巫峡' }),
  discuss: async (input: { messages: unknown[] }) => input.messages.length === 0
    ? { reply: '请确认接团城市和产品形态', brief: { destination: '', productForm: '', days: 2, userIdea: '第一天三峡之巅，第二天游巫峡' } }
    : { reply: '已整理，请核对', brief: { destination: '重庆', productForm: 'groupTour', days: 2, userIdea: '第一天三峡之巅，第二天游巫峡；接团城市重庆' } },
} } } as unknown as typeof window.vbk;
function Fixture() {
  const [input, setInput] = useState<CreateProductInput>({ destination: '', days: 2, productForm: 'privateTour' });
  return <main><ProductBriefForm input={input} setInput={setInput} autoConfirm={false} setAutoConfirm={() => {}} submitting={false} onCancel={() => {}} onSubmit={value => { (window as any).created = value; }} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
