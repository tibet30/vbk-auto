---
name: VBK Desktop
status: concept
style: kaimu-aligned-light-workbench
reference: /Users/cisco/pro/kaimu/DESIGN.md
colors:
  background: "#ffffff"
  foreground: "#09090b"
  app-surface: "#fafafa"
  muted: "#f4f4f5"
  muted-foreground: "#71717a"
  border: "#e4e4e7"
  primary: "#18181b"
  primary-foreground: "#fafafa"
  link-blue: "#2563eb"
  success-green: "#16a34a"
  ai-teal: "#0d9488"
  warning-amber: "#d97706"
  destructive: "#dc2626"
layout:
  base-unit: 4px
  rail-width: 56px
  topbar-height: 44px
  panel-padding: 16px
  control-height: 36px
  divider-width: 6px
radius:
  card: 12px
  control: 8px
  small: 6px
---

# VBK Desktop Design Direction

VBK Desktop inherits Kaimu's compact shadcn-style light production workspace. It is a serious operating tool: neutral white and zinc surfaces, precise borders, restrained shadows, compact controls, Chinese-first typography, and semantic accent colors.

## Interaction Thesis

The application is one continuous workspace expressed as two freely switchable stages:

- Step 1, “AI 对话与产品审查”: conversation and the complete structured product review stay side by side. AI receives slightly more width, while readiness and blocking items remain continuously visible.
- Step 2, “审查结果与 VBK 录入”: a compact review-result rail keeps the approved facts, remaining blockers, and safety boundary visible while the signed-in VBK page becomes dominant.
- A persistent two-step navigator shows completion, blockers, active automation, and saved-draft status in text as well as color. Operators can switch stages at any time without losing conversation, review, task, or browser state.
- Entering Step 2 early is allowed for inspection and live platform lookup. Saving remains disabled until the product review passes.

The browser is not a modal or separate application window. It is a first-class Step 2 workspace that keeps login state, page location, research tasks, and automation progress visible without covering Step 1.

## Visual Language

- Background: `#fafafa`; main panels and browser chrome: white.
- Text: zinc-black `#09090b`; secondary text `#71717a`.
- Borders: `#e4e4e7`; use borders and spacing before shadows.
- Primary actions: black with white text.
- AI suggestions, research activity, and model provenance: teal `#0d9488`.
- Confirmed or resolved data: green `#16a34a`.
- Platform links and selected inline references: blue `#2563eb`.
- Missing evidence or stale estimates: amber `#d97706`.
- Blocking validation failures: red `#dc2626`.
- No gradients, glassmorphism, glowing borders, decorative travel photography, or oversized dashboard metrics.

## Typography and Density

- Use the macOS system Chinese stack: `-apple-system`, `BlinkMacSystemFont`, `PingFang SC`, `Microsoft YaHei`, sans-serif.
- Body and workspace text: 13px.
- Labels and helper text: 12px.
- Badges and dense metadata: 10–11px.
- Workspace title: 20–22px, bold.
- IDs, resource codes, prices, and execution timestamps use a compact monospaced stack.
- Controls are 36px high; compact toolbar controls may be 32px.

## Application Shell

- A 56px global rail holds the VBK Desktop mark, product history, resource library, execution records, settings, and account switcher.
- A 44px top bar shows the current product, VBK login/account state, readiness, and the safe save-draft action.
- Below it, a persistent two-step progress navigator controls which stage is visible and explains each stage's current state.
- The active stage contains exactly two connected work areas: AI plus full review in Step 1; review result plus embedded VBK browser in Step 2.
- Panel headers remain fixed while their content scrolls independently.
- Non-detail pages such as the workbench home and product list use the shared centered content width: max `980px` with 16px side gutters at narrow sizes.
- Product detail is the exception: it uses the full available main area for the current two-panel stage. At narrow widths, those two panels stack; the inactive stage is not rendered.

## AI Workspace

- Conversation is the primary interaction surface, not a narrow support chat.
- The structured result is always reachable beside or above the conversation inside the AI side; it must never be hidden in raw JSON.
- AI messages can attach proposed changes, resource matches, evidence, and questions.
- Proposed data shows an explicit state: proposed, researching, resolved, needs confirmation, confirmed, or blocked.
- A persistent composer supports follow-up requests throughout planning and exception resolution.
- Parallel research appears as a compact task strip with meaningful labels such as “匹配城市ID”, “查询门票”, and “估算用车”, not animated novelty.

## Structured Product Review

- Organize the product into stable sections: basic information, daily itinerary, resources, images, cost and pricing, terms, and unresolved items.
- Each section shows completeness and evidence freshness without turning every block into a card.
- Values resolved from VBK show the platform label and ID together.
- Estimated web prices show source, retrieval time, and whether the user has accepted the estimate.
- The final “确认产品方案” action stays unavailable while blocking fields remain unresolved.

## VBK Browser and Automation

- Browser chrome is minimal: account, back/forward, refresh, current host, and open externally.
- Before planning, the browser opens the confirmed VBK product-list URL and asks the user to log in if necessary.
- During automation, a narrow execution panel lists stages, current action, retry, and pause controls while the actual VBK page remains dominant.
- Automation ends at a saved product. The completion state explicitly says that publishing remains manual.

## Motion

- Use short 160–280ms transitions for stage changes, progress state, and newly resolved fields.
- Research results reveal once with a subtle vertical fade.
- Avoid pulsing surfaces except a tiny active-task indicator.
- Respect `prefers-reduced-motion`.

## Implementation Rules

- Design should prioritize operational efficiency over visual novelty.  
- Chinese text is default in interface copy and workflows unless a field must remain English (e.g., code IDs, external brand names).
- Keep normal pages compact with a centered content width (max `980px`) and `16px` side gutters; exception pages may use full width by component-level decision.
- Prefer stable borders, clear spacing, and readable density over heavy shadows or animation.
- Every stage switch and status update should have an explicit source of truth (state icon + text), not only color.
- Keep keyboard and screen-reader basics in scope for shared form controls and important action buttons.
