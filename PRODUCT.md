# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are travel-product operators working on macOS. They turn a natural-language trip request into a complete, reviewable VBK product and need to verify platform identifiers, supplier resources, costs, images, and pricing before any data is entered.

## Product Purpose

VBK Desktop combines a multi-turn AI planning workspace with the signed-in VBK back office. It helps an operator refine an itinerary, research and resolve missing operational data, confirm a structured product, and then automate product entry. Success means the VBK product is fully saved for the operator to review and publish manually.

## Positioning

Unlike a generic itinerary chatbot, VBK Desktop grounds AI output in the live VBK account: platform dictionaries and IDs, vehicle resource groups, historical pricing rules, product requirements, and locally retained evidence are resolved before automation starts.

## Operating Context

- The operator signs in with a Tibet-managed application account before the local workspace is mounted; a still-valid session is restored automatically on later launches.
- The user signs in to VBK before starting the AI workflow.
- The AI conversation may span many rounds while a structured itinerary and product record update alongside it.
- Multiple AI research tasks may run in parallel to resolve city IDs, images, ticket prices, vehicle estimates, and other incomplete data.
- The AI workspace and the embedded VBK browser share a resizable split view. Planning favors the AI side; execution favors the VBK side.
- Confirmed data invokes the existing resumable browser automation and stops after the product is saved. Publishing remains manual in VBK.

## Capabilities and Constraints

- Product name: VBK Desktop.
- First release supports macOS; Windows may follow later.
- MiniMax provides multi-turn AI planning and research orchestration.
- The signed-in VBK session is required for platform resource reads and authoritative price calculation.
- AI may search the web for public ticket prices and suitable images, with source and freshness retained for review.
- Cost and recommended price calculations must be inspectable and user-confirmed.
- Most data, conversations, account profiles, resource snapshots, product versions, and automation checkpoints stay local.
- Application access uses Tibet's managed extension-user API. The main process retains the short-lived token locally; passwords never persist and the renderer never receives the token.

## Brand Commitments

- Use the product name “VBK Desktop”.
- Use “登录VBK” consistently; do not use “VBP”.
- The product should feel like a focused professional operating workspace, not a consumer travel-planning application.
- Use Kaimu's compact, light, shadcn-style production workspace as the visual reference, adapted to VBK Desktop's split AI/browser workflow.

## Evidence on Hand

- `examples/taiyuan-private-2d1n.json` contains the reference structured-product scope.
- Existing Node.js and Playwright modules cover VBK login, product entry, checkpoints, submission, publishing, and audits; the desktop product will reuse the safe entry stages and stop before publishing.
- The confirmed VBK product-list entry is `https://vbooking.ctrip.com/ivbk/vendor/productListMerge?from=vbk`.
- `/Users/cisco/pro/kaimu/DESIGN.md` and the current Kaimu web workspace provide the approved external visual reference.

## Product Principles

- Conversation and structured product state must always stay visibly connected.
- AI suggestions become operational data only after evidence, platform resolution, and user confirmation.
- Every computed price and resolved identifier must be traceable.
- The interface should change emphasis as work moves from planning to execution.
- Automation is observable, resumable, and never publishes the product.

## Accessibility & Inclusion

The desktop interface should support keyboard navigation, clear focus states, readable Simplified Chinese, scalable text, and status communication that does not depend on color alone.
