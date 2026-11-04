import { createRoot } from 'react-dom/client';
import { AppWorkspaceReviewSummaryOpenIssues } from '../../../src/renderer/app/views/workspace/review-summary-open-issues';
import type { ProductDetail, ResearchTask } from '../../../src/shared/contracts-types';
import '../../../src/renderer/styles/reset.css';
import '../../../src/renderer/styles/tokens.css';
import '../../../src/renderer/styles/global.css';

const product = { id: 'p1', product: { itinerary: [{ day: 1, spots: [{ name: '松花湖' }] }] } } as unknown as ProductDetail;
const task = { id: 't1', label: '核查 松花湖 的 VBK POI 映射', type: 'vbk', status: 'queued', state: 'researching', detail: '已找到多个候选 POI' } as ResearchTask;
(window as any).deletions = [];
createRoot(document.getElementById('root')!).render(<main><AppWorkspaceReviewSummaryOpenIssues
  product={product} readiness={{ ready: false, completion: 80, issues: [{ label: task.label, detail: task.detail }] }} taskList={[task]}
  setVerificationNote={() => {}} setActiveTask={() => {}} collapsed={false} onToggleCollapsed={() => {}} refreshing={false} onRefresh={() => {}}
  onDeletePoiIssue={async (target, name) => { (window as any).deletions.push({ target, name }); }}
/></main>);
