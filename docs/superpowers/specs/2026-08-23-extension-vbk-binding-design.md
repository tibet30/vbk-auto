# Extension VBK Binding Design

Date: 2026-08-23  
Status: approved for planning  
Repos: `vbk-auto` (desktop) + `/Users/cisco/pro/tibet` (backend)

## Problem

Settings currently store 400 phone and butler contact as local SQLite settings keyed only by VBK account name (`accountFixedInfo:${accountName}`). That creates three failures:

1. Switching the Tibet/app login user (e.g. to 党荣) does not reload that user's 400 / butler configuration.
2. Different VBK accounts under the same person need different 400 / butler values, but there is no Tibet-user-scoped row model.
3. Data is machine-local only; reinstall or another Mac loses the bindings.

## Goals

- Tibet `ExtensionUser` is the ownership root for VBK bindings.
- One Tibet user may bind many VBK accounts; each binding has its own `servicePhone` and butler contact card.
- Switching Tibet user loads that user's bindings and restores the last-active VBK WebView session when local cookies exist.
- Binding rows are authoritative on Tibet; desktop keeps a cache.
- VBK cookies remain local-only (not uploaded).

## Non-goals

- Syncing VBK cookies / WebView partitions to Tibet.
- Changing product-level butler overrides already stored on product JSON (`operations.bookingControls.butler`).
- Rich multi-device merge UI beyond `updatedAt` remote-wins.
- Forced deletion of all legacy `accountFixedInfo:*` keys in the first ship.

## Current state (baseline)

| Piece | Today |
|-------|--------|
| Desktop fixed info | `src/main/infrastructure/database/fixed-info.ts` → settings key `accountFixedInfo:${accountName}` |
| Fields | `servicePhone` (text), `butlerName` (`ContactCardSelection`) |
| Settings UI | `src/renderer/app/views/settings/vbk-login-block.tsx` + account editor |
| Automation readers | `resolveServicePhone` / `resolveButlerSelection` in automation helpers |
| Tibet auth | `ExtensionUser` + `/api/extension/auth/*` |
| Tibet products | `DesktopProduct` already scoped by `extension_user` |

## Data model (Tibet)

New table / model: `ExtensionVbkBinding` → `tblExtensionVbkBinding`.

| Column | Type | Notes |
|--------|------|--------|
| `id` | PK | |
| `extension_user_id` | FK → `tblExtensionUser` | CASCADE delete |
| `vbk_account_key` | varchar(150) | Stable id; prefer `vbk_xxx` loginAccount |
| `vbk_account_name` | varchar(150) | Display name |
| `provider_id` | bigint null | Cached partyId / providerId |
| `service_phone` | varchar(64) blank | 400 phone |
| `butler_contact_card_id` | int null | |
| `butler_display_name` | varchar(150) blank | |
| `butler_provider_id` | bigint null | |
| `last_used_at` | datetime null | Newest = active binding for that user |
| `created_at` / `updated_at` | datetime | |

Constraints:

- `UNIQUE (extension_user_id, vbk_account_key)`
- Active VBK for a user = row with max `last_used_at` (no separate `is_active` boolean)

Authority:

| Data | Source of truth |
|------|-----------------|
| 400 / butler / last-active VBK key | Tibet `tblExtensionVbkBinding` |
| VBK cookies / partitions | Local desktop only |
| Legacy `accountFixedInfo:*` | Migration source + short-lived cache fallback |

Desktop cache may keep:

- per-user snapshot: e.g. settings / file keyed by `extensionUserId`
- optional mirror of `accountFixedInfo` for offline automation, written only through the sync layer

## API (Tibet extension token)

All routes require `Authorization: Bearer` via existing `extension_token_required`.

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/extension/vbk-bindings` | List bindings for current user; include derived `activeVbkAccountKey` |
| `PUT` | `/api/extension/vbk-bindings/{vbkAccountKey}` | Upsert fields (`vbkAccountName`, `providerId`, `servicePhone`, `butler`); omitted fields unchanged; `butler: null` clears |
| `POST` | `/api/extension/vbk-bindings/{vbkAccountKey}/activate` | Set `last_used_at = now` |
| `DELETE` | `/api/extension/vbk-bindings/{vbkAccountKey}` | Delete remote binding only (local cookies untouched) |

List item shape:

```json
{
  "vbkAccountKey": "vbk_671205",
  "vbkAccountName": "党荣",
  "providerId": 123456,
  "servicePhone": "400-xxx-xxxx",
  "butler": {
    "contactCardId": 1,
    "displayName": "小王",
    "providerId": 123456
  },
  "lastUsedAt": "2026-08-23T10:00:00+08:00",
  "updatedAt": "2026-08-23T10:00:00+08:00"
}
```

Admin: register `ExtensionVbkBinding` in Django Admin for support.

## Sync sequences (desktop)

### Tibet login / switch user

1. Authenticate / activate Tibet user.
2. `GET /api/extension/vbk-bindings`.
3. If remote list empty → claim local `accountFixedInfo:*` into upserts (first-login migration), then re-list.
4. Write local per-user cache.
5. Resolve `activeVbkAccountKey`:
   - local cookies present → `browser.switchAccount`
   - missing cookies → keep/clear WebView; settings show remote 400/butler read-only with “本机尚未登录该 VBK” hint
6. Bump UI reload token so settings re-read fixed info.

### Edit 400 / butler in settings

1. Save through sync layer scoped by `(currentExtensionUserId, vbkAccountKey)`.
2. `PUT` remote; on success update local cache.
3. Existing IPC `accounts.saveFixedInfo(accountName, values)` stays as the renderer API; implementation routes through sync.

### VBK switch / new login success

1. Upsert at least `vbkAccountKey` / name / `providerId`.
2. `activate` that key.
3. Include any pending local fixed-info fields on upsert.

### Offline / conflict

- Offline writes mark local dirty and update cache.
- On reconnect, flush dirty upserts.
- Conflict rule: **remote `updatedAt` wins**; overwrite local and surface a notice.

## Desktop change map

Main process:

- Add `src/main/infrastructure/tibet-vbk-bindings.ts` (HTTP client).
- Add sync/orchestration module (keep files ≤350 lines).
- Hook `appAuth` login / switch / status restore → pull + migrate + restore VBK.
- Hook VBK login / switch / `saveFixedInfo` → upsert + activate.
- Point automation helpers at sync-scoped reads (same public helpers, new backing store).

Renderer:

- Keep settings blocks largely intact.
- On app-account switch, refresh fixed-info + login-account snapshot.
- Empty-state copy when remote binding exists without local session.

Compatibility:

- Do not break existing IPC method names in the first ship.
- Product JSON butler remains product-level override over account default.

## Backend change map (`/Users/cisco/pro/tibet`)

- Model + migration for `ExtensionVbkBinding`
- Views + URL routes under `/api/extension/vbk-bindings*`
- Admin registration
- Tests in `api/tests/` mirroring desktop-product coverage

## Migration policy

On first successful binding list for a Tibet user when remote is empty:

1. Scan local settings keys `accountFixedInfo:*`.
2. Upsert each non-empty record under that user (key = account name / known loginAccount best-effort).
3. Activate current VBK if known.
4. Leave legacy keys in place as read fallback until a later cleanup.

## Acceptance gates

| ID | Scenario | Expected |
|----|----------|----------|
| A1 | User 甲 saves 400/butler for VBK-A | Remote row exists; local cache matches; settings show values |
| A2 | Same user configures VBK-B differently | Two rows; switching A/B updates display + automation resolution |
| A3 | Switch to Tibet user 乙 with existing remote bindings | Settings show 乙 only; attempt restore 乙 active VBK |
| A4 | 乙 active VBK has no local cookies | No crash; prompt to login; remote 400/butler still visible |
| A5 | New Tibet user, empty remote, local legacy fixed info | First sync claims/uploads; thereafter remote-authoritative |
| A6 | Offline local edit vs newer remote | Remote wins on sync; user notified |
| A7 | Automation basic-info fill | Uses current Tibet user + current VBK binding; clear error if missing |
| A8 | Django Admin | Binding rows visible/editable |

## Risks

- **Key drift** between display name and `vbk_xxx`: primary key is always `vbk_account_key`.
- **Shared machine cookies across Tibet users**: cookies may be reused locally; fixed info must stay user-scoped.
- **Backend not deployed yet**: desktop degrades to local cache and shows “远端绑定服务暂不可用”.
- **File size**: new modules must respect the ≤350 (±50) line rule.

## Implementation order (planning hint)

1. Tibet model/migration/API/tests.
2. Desktop HTTP client + sync layer + unit tests.
3. Wire appAuth + VBK lifecycle hooks.
4. Settings UI empty states / reload.
5. Automation reader verification.
6. First-login local claim migration.
7. End-to-end acceptance A1–A8.

## Open decisions (resolved in brainstorm)

- Trigger account: Tibet/app user (not VBK-only).
- Cardinality: one Tibet user → many VBK bindings.
- On Tibet switch: restore last-active VBK session when possible.
- Storage: dedicated `tblExtensionVbkBinding`.
- Migration: claim local fixed info into the current Tibet user on first empty remote pull.
- Conflict: remote `updatedAt` wins.
