# Price Input UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix native browser number-spinner arrows, anchor the `¥` prefix, and tighten the editor chrome in the product-review price editors (`EditablePricingField` + `EditableVehicleField`).

**Architecture:** Single-file CSS-only change in `src/renderer/styles.css`. Both editors share `.manual-input-wrap`, so one set of selectors covers them. No JSX, no state, no new tokens.

**Tech Stack:** CSS Grid, CSS custom properties (existing `--border`, `--border-strong`, `--muted-foreground`, `--foreground`, `--radius-sm`, `--control-sm`, `--fs-sm`).

## Global Constraints

- Existing tokens only — no new CSS variables, no new color values.
- No JSX changes. Component props (`inputMode`, `type`, `step`, `min`, validation) stay identical.
- Visual order in the editor: inputs → optional hint (vehicle) → optional error → button row. No DOM order change.
- All hover, focus, and disabled states must continue to work; no selector collision with `.manual-field-label input` (which has its own border treatment).

---

## File Map

**Modify (1):**
- `src/renderer/styles.css` — scoped changes to existing selectors in the `.manual-field-editor` block (lines ~1516–1640).

**Create (0):**
- No new files.

**No other files touched.** JSX, types, tests, package.json all stay the same.

---

## Task 1: Hide native number spinner in `.manual-input-wrap`

**Files:**
- Modify: `src/renderer/styles.css:1552-1565` (the `.manual-input-wrap input` rule block)

**Why:** Both editors wrap `<input type="number">` in `.manual-input-wrap`. Native browsers (WebKit/Safari/Chrome and Firefox) each render their own arrow buttons inside the input. Hiding them keeps numeric semantics but removes the clutter.

**Interfaces:**
- Consumes: existing `.manual-input-wrap` selector.
- Produces: numeric inputs inside `.manual-input-wrap` no longer show native arrows.

- [ ] **Step 1: Add spinner-hiding rules**

Edit `src/renderer/styles.css` to add a new rule immediately after the existing `.manual-input-wrap input { padding: 0 8px 0 4px; }` rule (currently line 1565). Add:

```css
/* Hide native number-input spinners; numeric semantics (inputMode/step/min)
   are preserved by the JSX. The ¥ wrapper is a single primitive for both
   the adult/child price grid and the target-price match row. */
.manual-input-wrap input[type='number'] {
  appearance: none;
  -moz-appearance: textfield;
}

.manual-input-wrap input[type='number']::-webkit-inner-spin-button,
.manual-input-wrap input[type='number']::-webkit-outer-spin-button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
}
```

- [ ] **Step 2: Verify in browser**

Run `npm run dev`. In the renderer, open a product project → click **手动调整** on the **成人 / 儿童估价** field. Confirm: no arrows visible inside the adult/child inputs; numeric input still works (typing `1500.50`, arrow keys, paste all function); `¥` glyph still present.

Also click **按价格调整** on **VBK 用车资源**. Confirm the single price input shows no arrows.

- [ ] **Step 3: Verify build**

Run `npm run check`. Expected: PASS (no TS errors since no JSX changed).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/styles.css
git commit -m "styles: hide native number-input spinner in price editor

Removes the up/down arrows that browsers render inside <input type=\"number\">.
Numeric semantics (inputMode, step, min, validation) are preserved.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Anchor the `¥` prefix and lift wrapper border

**Files:**
- Modify: `src/renderer/styles.css:1537-1550` (the `.manual-input-wrap` block)

**Why:** The `¥` glyph and the wrapper border both read flat — the glyph gets visually clipped against the input border, and the wrapper blends into `--surface`. Two changes: (a) the `¥` cell gets its own padding, divider line, and tabular-nums; (b) the wrapper gets a hover lift so it doesn't disappear into the field.

**Interfaces:**
- Consumes: existing `.manual-input-wrap` rule; existing `.manual-input-wrap:focus-within` rule.
- Produces: `¥` glyph reads as a fixed chip with a thin vertical divider; wrapper border visibly darkens on hover.

- [ ] **Step 1: Update the `.manual-input-wrap` base rule**

Replace the existing `.manual-input-wrap` block (lines 1537–1548) with:

```css
.manual-input-wrap {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  min-width: 0;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--muted-foreground);
  transition: border-color 140ms var(--motion);
}

.manual-input-wrap:hover { border-color: var(--border-strong); }

.manual-input-wrap:focus-within { border-color: var(--foreground); box-shadow: 0 0 0 2px color-mix(in srgb, var(--foreground) 10%, transparent); }
```

Notes on what changed:
- `height: 30px` → `32px` to align with `--control-sm`.
- `padding-inline-start: 8px` removed — the `¥` cell now carries its own padding.
- Added `transition` so the hover lift animates smoothly.
- Kept the existing `:focus-within` rule unchanged.

- [ ] **Step 2: Style the `¥` prefix and adjust the inner input**

Immediately after the existing `.manual-input-wrap input { padding: 0 8px 0 4px; }` rule (currently line 1565), add a new rule for the prefix cell and update the inner input padding:

Replace the line:
```css
.manual-input-wrap input { padding: 0 8px 0 4px; }
```
with:
```css
.manual-input-wrap > span:first-child {
  padding-inline: 8px;
  font-variant-numeric: tabular-nums;
  border-inline-end: 1px solid var(--border);
  line-height: 1;
}

.manual-input-wrap input { padding: 0 10px 0 10px; }
```

Notes:
- The first-child selector matches the leading `<span>¥</span>` directly without requiring a new class on the JSX side. Confirmed by reading `App.tsx:1214-1215` and `App.tsx:1262` — both editors place the `¥` span as the first child.
- `border-inline-end` draws a 1px vertical divider between the `¥` chip and the input.
- Input padding bumped from `0 8px 0 4px` to `0 10px 0 10px` so the digits aren't pushed against the divider.

- [ ] **Step 3: Verify in browser**

With `npm run dev` still running:
1. Hover the price input wrapper — the border should visibly darken from `--border` (#e4e4e7) to `--border-strong` (#d4d4d8).
2. Focus the input — the existing focus ring still appears.
3. Type a long number like `150000` — the `¥` glyph stays anchored on the left with a thin divider between it and the digits; no clipping.
4. Repeat for the vehicle price input.

- [ ] **Step 4: Verify build**

Run `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/styles.css
git commit -m "styles: anchor ¥ prefix and lift price-input wrapper on hover

The leading <span>¥</span> cell now carries its own padding, a vertical
divider, and tabular-nums. Wrapper height matches --control-sm and lifts
to --border-strong on hover. Border, focus ring, and inner input
behavior are unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Tighten editor chrome (button height, save weight, gap)

**Files:**
- Modify: `src/renderer/styles.css:1516-1520` (`.manual-field-editor`) and `src/renderer/styles.css:1620-1640` (`.manual-field-buttons` block).

**Why:** The user asked to polish the whole `manual-field-editor`, not just the input. The cancel/save buttons currently sit at 28px while other primary controls in the app use `--control-sm` (32px). The save button lacks `font-weight: 600`, making it visually lighter than the matching `.vehicle-match-button`.

**Interfaces:**
- Consumes: existing `.manual-field-editor` and `.manual-field-buttons` rules.
- Produces: button row at consistent 32px height; save button visually matches `.vehicle-match-button` weight.

- [ ] **Step 1: Lift `.manual-field-buttons button` to 32px**

Edit the existing `.manual-field-buttons button` rule (line 1627). Change `min-height: 28px;` to `min-height: var(--control-sm);` (32px). Leave padding, border, radius, color unchanged.

Result:
```css
.manual-field-buttons button {
  min-height: var(--control-sm);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  font-size: 11px;
}
```

- [ ] **Step 2: Add font-weight to the save button**

Edit the existing `.manual-field-buttons .manual-field-save` rule (line 1638). Add `font-weight: 600;` so it visually matches the `.vehicle-match-button` next door.

Result:
```css
.manual-field-buttons .manual-field-save { display: inline-flex; align-items: center; gap: 5px; border-color: var(--foreground); background: var(--foreground); color: var(--primary-foreground); font-weight: 600; }
```

- [ ] **Step 3: Adjust `.manual-field-editor` gap rhythm**

Edit the existing `.manual-field-editor` rule (line 1516). Confirm `gap: 10px;` and `padding-top: 6px;` — these are already at the spec'd values. No change needed. (If for some reason the file shows `gap: 8px;` instead, change to `10px`.)

- [ ] **Step 4: Verify in browser**

1. Click **手动调整** on the price field; the cancel/save buttons should be the same height as the input wrapper (both 32px).
2. The save button (黑色) should look the same weight as the **匹配资源组** button to the right of the vehicle input.
3. Hover the cancel button — it should still ghost-highlight via the existing `:hover` rule.
4. Trigger a validation error (e.g., type `0` for adult price) — the error text should appear above the buttons with breathing room.

- [ ] **Step 5: Verify build**

Run `npm run check`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/styles.css
git commit -m "styles: align manual-editor buttons with --control-sm

Bumps cancel/save buttons from 28px to var(--control-sm) (32px) and adds
font-weight: 600 to the save button so it matches the .vehicle-match-button
weight next door. The .manual-field-editor gap stays at 10px.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Hide native spinner arrows | Task 1 |
| `¥` prefix anchored (padding, divider, tabular-nums) | Task 2 |
| Wrapper border visible on surface | Task 2 (hover lift) |
| Focus ring preserved | Task 2 (existing `:focus-within` kept verbatim) |
| Two-column `.manual-price-grid` untouched | n/a (no change in any task) |
| `.vehicle-price-match-row` same fix | Task 1 + Task 2 apply via shared `.manual-input-wrap` |
| Editor chrome polish (button height, gap, save weight) | Task 3 |
| No new tokens, no JSX, no behavior change | All tasks |

**Placeholder scan:** No "TBD", "TODO", "implement later". Every step shows actual code.

**Type consistency:** No new types or function signatures introduced; nothing to cross-check.

**Risks noted in plan:**
- `> span:first-child` selector relies on `¥` being the first child of `.manual-input-wrap`. Verified at `App.tsx:1214-1215` and `App.tsx:1262`.
- `appearance: none` on Firefox for `type=number` is supported in 73+; `-moz-appearance: textfield` is the legacy fallback and harmless.