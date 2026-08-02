# Price Input UI Polish — Design

## Context

The price inputs in the product-review panel render with native browser number-spinners and a flat wrapper, producing three visible defects:

1. Native up/down arrows clutter the inside of the input (WebKit/Safari/Chrome and Firefox each show their own variant).
2. The `¥` prefix gets visually clipped against the input border.
3. The wrapper border reads flat next to the surrounding `--surface`, so the field loses focus in the form.

Two editors share the same primitive:

- `EditablePricingField` — adult/child price grid (`.manual-price-grid`).
- `EditableVehicleField` — single target daily price with a match button to its right (`.vehicle-price-match-row`).

Both wrap `<input type="number">` in `.manual-input-wrap` with a leading `<span>¥</span>`. Same root cause → same fix lands once.

The goal: keep numeric semantics identical (same `inputMode`, `step`, `min`, validation), only fix the visuals, and lift a few related editor-wide rough edges (button height, gap rhythm) that the user flagged as part of the same request.

## Goals

- Remove native spinner arrows without losing numeric validation.
- Make the `¥` prefix read as an anchored chip rather than floating punctuation.
- Give the wrapper a border that holds up next to surrounding surface; preserve the existing focus ring.
- Tighten `.manual-field-editor` button row and gap rhythm.
- One CSS-only change; no JSX, no state, no new tokens.

## Non-goals

- No new +/- replacement buttons (would crowd the two-column price grid).
- No switch to `type="text"` + custom regex validation (loses browser semantics for no gain).
- No changes to field labels, validation messages, save/cancel copy, or component props.

## Design

### 1. `.manual-input-wrap` (shared primitive)

Keep the existing 2-track `auto minmax(0, 1fr)` grid. The divider is drawn by the left cell, not by an extra grid track, so no empty DOM cell is needed.

- Left cell: `¥` glyph.
  - `padding-inline: 8px`, color `var(--muted-foreground)`, `font-variant-numeric: tabular-nums`.
  - `border-inline-end: 1px solid var(--border)` to draw the divider via the cell, not the wrapper.
  - Keeps the glyph anchored regardless of input width or caret position.
- Right cell: input.
  - Hide native spinner via `appearance: none` and the WebKit pseudo-element overrides. Firefox respects `appearance: none` on `type=number` (per MDN); combined rules cover all three engines.
  - Keep existing transparent border, focus-visible styling unchanged.
- Wrapper hover: lift border to `var(--border-strong)` for tactile feedback. Focus state stays at `var(--foreground)` with the existing 2px ring.

### 2. Inner `<input>` (covers both editors)

Selector: `.manual-input-wrap input[type='number']`.

```css
appearance: none;
-moz-appearance: textfield;
```

Plus the standard WebKit pseudo-element overrides already used elsewhere in this stylesheet (`.manual-input-wrap input::-webkit-inner-spin-button`, `::-webkit-outer-spin-button`) set to `display: none; -webkit-appearance: none; margin: 0;`. If those pseudos aren't already present, add them — the codebase already references vendor-prefixed pseudos for other controls, so the idiom fits.

`inputMode`/`step`/`min` on the JSX side are untouched, so:

- Adult: `inputMode="decimal" step="0.01" min="0.01"` — still rejects `0`.
- Child: `inputMode="decimal" step="0.01" min="0"` — accepts `0`.
- Vehicle: `inputMode="numeric" step="1" min="1"` — integer-only.

### 3. `.manual-price-grid` (adult/child)

No layout change. Two columns at `minmax(0, 1fr)`, `gap: 8px`. The wrapper fix is what changes here.

### 4. `.manual-field-editor` chrome

- `gap: 10px` (was 8px) so hint and error breathe.
- Visual order stays: inputs → optional hint (vehicle field only) → optional error → button row. No DOM change, just spacing.
- `.manual-field-buttons button`: bump `min-height` from `28px` → `32px` (`--control-sm`) to match other primary controls in the app.
- `.manual-field-save`: add `font-weight: 600` for parity with `.vehicle-match-button` (which is already 600 by virtue of being a primary action). Cancel stays muted.

### 5. `.vehicle-price-match-row`

Same wrapper fix applies (it uses the same `.manual-input-wrap`). The `匹配资源组` button to the right is already styled — no change.

## Why CSS-only

Both `EditablePricingField` (App.tsx:1186) and `EditableVehicleField` (App.tsx:1222) emit identical structure:

```tsx
<span className="manual-input-wrap">
  <span>¥</span>
  <input ... type="number" ... />
</span>
```

A single CSS rule on `.manual-input-wrap` (plus the input pseudo-element overrides) fixes both. The vehicle row adds a grid sibling button, but the wrapper itself is the same. Component contracts don't change, so no JSX diff is needed.

## Files

- `src/renderer/styles.css` — only file touched. Changes scoped to existing selectors: `.manual-input-wrap`, `.manual-input-wrap input`, `.manual-price-grid`, `.manual-field-editor`, `.manual-field-buttons button`, `.manual-field-buttons .manual-field-save`. Possibly add the two WebKit pseudo-element overrides if not present.

No new files, no new tokens, no type changes, no test fixture changes.

## Testing

Visual (manual):

1. Open a project with pricing set, click "手动调整" on the price field.
2. Confirm: no spinner arrows inside the adult/child inputs; `¥` stays anchored on the left of each input; the input has a visible border; focusing the input shows the existing ring.
3. Type `1500.50`, blur — value persists; re-edit, type `0` for child — error shows; type `0` for adult — error shows (validation behavior unchanged).
4. Click "按价格调整" on the vehicle field; confirm the single price input has the same look; the `匹配资源组` button stays styled; type `450` and click match — preview shows; cancel closes cleanly.

Automated:

- `npm run test` (Vitest) — no behavioral change, all existing tests should pass.
- `npm run typecheck` if configured — no type changes.

## Risks

- **Spinner removal discoverability**: users lose visual cue that the field is numeric. Mitigated by `inputMode`, `step`, and the `¥` prefix.
- **`appearance: none` on Firefox**: per MDN, Firefox 73+ respects `appearance: none` on `type=number` and removes the spinner; `-moz-appearance: textfield` is the legacy idiom and harmless.
- **Color of `¥` glyph**: kept at `--muted-foreground` (not `--subtle`) so it stays legible against `--surface`; same value used by the field label.

## Out of scope

- Re-styling the field labels (`成人价`, `儿童价`, `目标每日用车价`) — they use the existing `.manual-price-grid > label` and `.manual-field-label` rules, which already render correctly.
- Changing the error copy.
- Changes to `EditableHotelResourceField` or any other field that doesn't use `.manual-input-wrap`.