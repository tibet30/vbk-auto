# Extension VBK Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per–Tibet-user VBK bindings (400 phone + butler) on Tibet, and make desktop settings / automation follow the active app account and its active VBK.

**Architecture:** New Tibet table `tblExtensionVbkBinding` owned by `ExtensionUser`. Desktop adds a Tibet HTTP client + sync layer; local `accountFixedInfo` becomes a per-user cache and migration source. Cookies stay local. Switching Tibet user pulls bindings and restores last-active VBK when cookies exist.

**Tech Stack:** Django (Tibet `/Users/cisco/pro/tibet`), Electron main/renderer TypeScript (`vbk-auto`), SQLite settings cache, Vitest / Django TestCase.

**Spec:** `docs/superpowers/specs/2026-08-23-extension-vbk-binding-design.md`

## Global Constraints

- Files ≤ 350 lines (±50); split rather than grow.
- Preserve unrelated dirty worktree changes in `vbk-auto`; only touch binding-related paths.
- Do **not** `git commit` / `git push` unless the user explicitly authorizes in this session.
- Cookies / WebView partitions never upload to Tibet.
- Product JSON `operations.bookingControls.butler` remains product-level override.
- Conflict rule: remote `updatedAt` wins.
- IPC names `accounts.getFixedInfo` / `accounts.saveFixedInfo` stay compatible.
- Brand copy: use「登录VBK」, not「VBP」.
- Tibet backend path: `/Users/cisco/pro/tibet`. Prefer a feature branch there; `vbk-auto` may stay on current branch with scoped edits.

## File map

### Tibet (`/Users/cisco/pro/tibet`)

| File | Role |
|------|------|
| `api/models.py` | Add `ExtensionVbkBinding` |
| `api/migrations/0022_extensionvbkbinding.py` | Schema |
| `api/views.py` | list / upsert / activate / delete handlers |
| `api/urls.py` | Routes under `/api/extension/vbk-bindings*` |
| `api/admin.py` | Admin registration |
| `api/tests/test_extension_vbk_bindings.py` | API tests |

### Desktop (`vbk-auto`)

| File | Role |
|------|------|
| `src/shared/contracts-vbk-binding.ts` (new) | Shared DTO types |
| `src/shared/contracts.ts` / exports | Re-export if needed |
| `src/main/infrastructure/tibet-vbk-bindings.ts` (new) | HTTP client |
| `src/main/infrastructure/vbk-binding-sync.ts` (new) | Sync + cache + migrate + activate restore |
| `src/main/infrastructure/database/fixed-info.ts` | Key by `(extensionUserId, accountKey)` cache path |
| `src/main/infrastructure/database/parts/provider-accounts.ts` | Wire scoped get/set |
| `src/main/ipc/browser-automation-ipc.ts` | saveFixedInfo → sync |
| `src/main/ipc/app-auth-ipc.ts` / `tibet-auth.ts` hooks | Pull on login/switch |
| `src/main/main.ts` | Wire services |
| `src/renderer/.../vbk-login-block.tsx` | Empty-state when remote-only |
| `test/infrastructure/tibet-vbk-bindings.test.ts` | Client tests |
| `test/infrastructure/vbk-binding-sync.test.ts` | Sync/migrate/conflict tests |

---

### Task 1: Tibet model + migration

**Files:**
- Modify: `/Users/cisco/pro/tibet/api/models.py` (after `DesktopProduct`)
- Create: `/Users/cisco/pro/tibet/api/migrations/0022_extensionvbkbinding.py`

**Interfaces:**
- Produces: model `ExtensionVbkBinding` with fields from spec; `db_table = "tblExtensionVbkBinding"`; unique `(extension_user, vbk_account_key)`

- [ ] **Step 1: Add model** after `DesktopProduct` in `api/models.py`:

```python
class ExtensionVbkBinding(models.Model):
    """Per ExtensionUser VBK account binding: 400 phone + butler contact."""

    extension_user = models.ForeignKey(
        ExtensionUser,
        on_delete=models.CASCADE,
        related_name="vbk_bindings",
        verbose_name="扩展用户",
    )
    vbk_account_key = models.CharField(max_length=150, verbose_name="VBK 账号键")
    vbk_account_name = models.CharField(max_length=150, blank=True, default="", verbose_name="VBK 展示名")
    provider_id = models.BigIntegerField(null=True, blank=True, verbose_name="providerId")
    service_phone = models.CharField(max_length=64, blank=True, default="", verbose_name="400 电话")
    butler_contact_card_id = models.IntegerField(null=True, blank=True, verbose_name="管家联系卡 ID")
    butler_display_name = models.CharField(max_length=150, blank=True, default="", verbose_name="管家显示名")
    butler_provider_id = models.BigIntegerField(null=True, blank=True, verbose_name="管家 providerId")
    last_used_at = models.DateTimeField(null=True, blank=True, verbose_name="最近使用")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "tblExtensionVbkBinding"
        verbose_name = "扩展用户 VBK 绑定"
        verbose_name_plural = verbose_name
        ordering = ["-last_used_at", "-updated_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["extension_user", "vbk_account_key"],
                name="uniq_extension_vbk_binding_user_key",
            ),
        ]

    def __str__(self):
        return f"{self.extension_user_id}:{self.vbk_account_key}"
```

Import `ExtensionUser` from `account.models` if not already imported in this file the same way `DesktopProduct` does.

- [ ] **Step 2: Create migration**

Run from `/Users/cisco/pro/tibet`:
`python manage.py makemigrations api --name extensionvbkbinding`

Expected: `0022_extensionvbkbinding.py` (or next number).

- [ ] **Step 3: Sanity check migration**

Run: `python manage.py migrate api --plan` (or `showmigrations api`)
Expected: new migration listed, no error.

- [ ] **Step 4: Do not commit** unless user authorized.

---

### Task 2: Tibet API + admin + tests

**Files:**
- Modify: `/Users/cisco/pro/tibet/api/views.py`
- Modify: `/Users/cisco/pro/tibet/api/urls.py`
- Modify: `/Users/cisco/pro/tibet/api/admin.py`
- Create: `/Users/cisco/pro/tibet/api/tests/test_extension_vbk_bindings.py`

**Interfaces:**
- Consumes: `ExtensionVbkBinding`
- Produces:
  - `GET /api/extension/vbk-bindings` → `{ code, data: { items: [...], activeVbkAccountKey } }`
  - `PUT /api/extension/vbk-bindings/<key>` → upsert item
  - `POST /api/extension/vbk-bindings/<key>/activate` → bump `last_used_at`
  - `DELETE /api/extension/vbk-bindings/<key>` → 200

- [ ] **Step 1: Write failing tests** in `api/tests/test_extension_vbk_bindings.py` covering:
  - upsert + list user-scoped
  - activate updates `activeVbkAccountKey`
  - other user cannot see/delete
  - butler null clears butler fields
  - partial PUT keeps omitted fields

Mirror auth setup from `test_desktop_products.py` (`ExtensionUser` + Bearer token).

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd /Users/cisco/pro/tibet && python manage.py test api.tests.test_extension_vbk_bindings -v2`
Expected: URL/model/view missing failures.

- [ ] **Step 3: Implement serializer helpers + views**

Payload item helper:

```python
def _vbk_binding_item(obj):
    butler = None
    if obj.butler_contact_card_id and obj.butler_display_name and obj.butler_provider_id:
        butler = {
            "contactCardId": obj.butler_contact_card_id,
            "displayName": obj.butler_display_name,
            "providerId": obj.butler_provider_id,
        }
    return {
        "vbkAccountKey": obj.vbk_account_key,
        "vbkAccountName": obj.vbk_account_name or obj.vbk_account_key,
        "providerId": obj.provider_id,
        "servicePhone": obj.service_phone or "",
        "butler": butler,
        "lastUsedAt": obj.last_used_at.isoformat() if obj.last_used_at else None,
        "updatedAt": obj.updated_at.isoformat() if obj.updated_at else None,
    }
```

Views: decorate with `@allow_cors_from_extension` + `@extension_token_required`. Scope all queries with `extension_user=request.extension_user`.

- [ ] **Step 4: Wire urls.py**

```python
path('extension/vbk-bindings', views.extension_vbk_bindings, name='extension_vbk_bindings'),
path('extension/vbk-bindings/<str:vbk_account_key>', views.extension_vbk_binding_detail, name='extension_vbk_binding_detail'),
path('extension/vbk-bindings/<str:vbk_account_key>/activate', views.extension_vbk_binding_activate, name='extension_vbk_binding_activate'),
```

Use method dispatch on detail for PUT/DELETE (or separate handlers matching existing style).

- [ ] **Step 5: Register Admin**

```python
@admin.register(ExtensionVbkBinding)
class ExtensionVbkBindingAdmin(admin.ModelAdmin):
    list_display = ("id", "extension_user", "vbk_account_key", "vbk_account_name", "service_phone", "butler_display_name", "last_used_at", "updated_at")
    search_fields = ("vbk_account_key", "vbk_account_name", "service_phone", "extension_user__name", "extension_user__phone")
    list_filter = ("extension_user",)
```

- [ ] **Step 6: Run tests — expect PASS**

Run: `python manage.py test api.tests.test_extension_vbk_bindings -v2`

---

### Task 3: Desktop shared types + Tibet HTTP client

**Files:**
- Create: `src/shared/contracts-vbk-binding.ts`
- Create: `src/main/infrastructure/tibet-vbk-bindings.ts`
- Create: `test/infrastructure/tibet-vbk-bindings.test.ts`
- Modify: shared barrel export if `contracts.ts` re-exports modules

**Interfaces:**
- Produces:

```ts
export interface VbkBindingButler {
  contactCardId: number;
  displayName: string;
  providerId: number;
}

export interface VbkBinding {
  vbkAccountKey: string;
  vbkAccountName: string;
  providerId?: number | null;
  servicePhone: string;
  butler: VbkBindingButler | null;
  lastUsedAt?: string | null;
  updatedAt?: string | null;
}

export interface VbkBindingsSnapshot {
  items: VbkBinding[];
  activeVbkAccountKey: string | null;
}

export interface TibetVbkBindingService {
  list(): Promise<VbkBindingsSnapshot>;
  upsert(vbkAccountKey: string, patch: Partial<{
    vbkAccountName: string;
    providerId: number | null;
    servicePhone: string | null;
    butler: VbkBindingButler | null;
  }>): Promise<VbkBinding>;
  activate(vbkAccountKey: string): Promise<VbkBinding>;
  delete(vbkAccountKey: string): Promise<void>;
}
```

- [ ] **Step 1: Write client unit tests** with mocked `fetch` (pattern from `test/infrastructure/tibet-products.test.ts`): list decode, upsert PUT path, 401 → clear message, missing session throws.

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- test/infrastructure/tibet-vbk-bindings.test.ts`

- [ ] **Step 3: Implement types + `createTibetVbkBindingService(store, options?)`** mirroring `tibet-products.ts` auth header / envelope handling.

- [ ] **Step 4: Run — expect PASS**

---

### Task 4: Sync layer (cache, migrate, conflict)

**Files:**
- Create: `src/main/infrastructure/vbk-binding-sync.ts`
- Create: `test/infrastructure/vbk-binding-sync.test.ts`
- Modify: `src/main/infrastructure/database/fixed-info.ts` — support scoped cache key `accountFixedInfo:${userId}:${accountKey}` while still reading legacy `accountFixedInfo:${accountKey}` for migration

**Interfaces:**
- Produces:

```ts
export interface VbkBindingSync {
  /** Pull remote; if empty, claim legacy local fixed info; write cache; return snapshot */
  syncFromRemote(extensionUserId: number): Promise<VbkBindingsSnapshot>;
  /** Read fixed info for UI/automation: prefer user-scoped cache */
  getFixedInfo(extensionUserId: number | null, accountName: string): AccountFixedInfo;
  /** Save locally + upsert remote when session present */
  saveFixedInfo(
    extensionUserId: number | null,
    accountKey: string,
    values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue | null>>,
    meta?: { accountName?: string; providerId?: number | null },
  ): Promise<AccountFixedInfo>;
  /** Upsert identity + activate; used on VBK switch/login */
  touchActive(
    extensionUserId: number,
    accountKey: string,
    meta?: { accountName?: string; providerId?: number | null },
  ): Promise<void>;
  /** Best-effort restore active VBK via callback */
  restoreActiveVbk(
    snapshot: VbkBindingsSnapshot,
    hasLocalSession: (key: string) => boolean,
    switchTo: (key: string) => Promise<void>,
  ): Promise<"switched" | "missing-cookies" | "none">;
}
```

- [ ] **Step 1: Failing tests** for: empty remote claims legacy keys; remote-wins on newer `updatedAt`; scoped get after save; touchActive calls upsert+activate.

- [ ] **Step 2: Implement sync module** (keep ≤350 lines; extract helpers if needed).

- [ ] **Step 3: Tests PASS**

Run: `npm test -- test/infrastructure/vbk-binding-sync.test.ts`

---

### Task 5: Wire main process lifecycle + IPC

**Files:**
- Modify: `src/main/main.ts` — construct binding service + sync; pass into IPC
- Modify: `src/main/ipc/app-auth-ipc.ts` — after login/switch/status authenticated, call `syncFromRemote` + `restoreActiveVbk`
- Modify: `src/main/ipc/browser-automation-ipc.ts` — `saveFixedInfo` / `getFixedInfo` through sync; on VBK account changes call `touchActive`
- Modify: VBK login success paths that set `vbkAccountName` / switch account (search `setSetting("vbkAccountName"` and `switchAccount`) to call `touchActive`
- Modify: automation helpers only if needed so they read scoped cache via db methods that know current extension user id from `appAuthStore.get()?.user.id`

**Interfaces:**
- Consumes: Task 3–4 services
- Current extension user id: `appAuthStore.get()?.user.id ?? null`

- [ ] **Step 1: Wire construction in `main.ts`**

- [ ] **Step 2: Hook appAuth success paths**

- [ ] **Step 3: Hook accounts IPC + VBK switch**

- [ ] **Step 4: Run focused tests**

Run: `npm test -- test/infrastructure/tibet-vbk-bindings.test.ts test/infrastructure/vbk-binding-sync.test.ts test/infrastructure/app-auth.test.ts`

- [ ] **Step 5: Manual smoke checklist note** in PR/report: A1–A4 paths

---

### Task 6: Settings UI empty state + reload on app account switch

**Files:**
- Modify: `src/renderer/app/views/settings/vbk-login-block.tsx`
- Modify: app-auth switch handlers in `AppAccountPopover` / `AppAuthContext` / rail — bump `fixedInfoReloadToken` and refresh VBK status after successful app account switch (expose a model callback if needed)

- [ ] **Step 1: When logged into Tibet binding exists but VBK not logged in**, show hint:「已绑定 VBK，本机尚未登录，请登录后继续」

- [ ] **Step 2: On app account switch success**, refresh fixed info + login accounts

- [ ] **Step 3: No browser tools for Electron shell — verify via unit/render tests if present, else manual note**

---

### Task 7: Acceptance verification

- [ ] **Step 1: Tibet** `python manage.py test api.tests.test_extension_vbk_bindings -v2` PASS

- [ ] **Step 2: Desktop** focused npm tests PASS

- [ ] **Step 3: Trace acceptance gates A1–A8** against code paths; list any gate that needs live Tibet deploy before E2E

- [ ] **Step 4: Stop for user review** — no commit/push unless authorized

---

## Self-review (plan vs spec)

| Spec section | Task |
|--------------|------|
| `tblExtensionVbkBinding` model | Task 1 |
| API list/upsert/activate/delete | Task 2 |
| Desktop HTTP client | Task 3 |
| Sync, migrate, remote-wins, restore VBK | Task 4–5 |
| Settings UX / reload | Task 6 |
| Acceptance A1–A8 | Task 7 |
| Cookies local-only | Global + Tasks 4–5 (never upload) |
| Product butler override unchanged | Global (no product JSON edits) |
