/** VBK 登录态、多账号与账号固定信息。 */
export interface VbkLoginStatus {
  loggedIn: boolean;
  message: string;
  /** VBK 页面展示名，例如"小璐"。 */
  accountName?: string;
  /** VBK 登录账号，例如"vbk_671205"。 */
  loginAccount?: string;
  accounts?: string[];
}

/**
 * 本机已记录但**当前 WebView 未在线**的 VBK 登录账号。
 *
 * 多账号登录的工作流是这样的：
 *  - WebView 同一时刻只能显示一个账号；
 *  - "新增登录"会把当前账号的 cookies 抽出来存进 settings 表（key = 登录账号）；
 *  - 切到已记录的账号时再把 cookies 回灌到 session。
 *
 * lastUsedAt 只用来给 UI 排序（最近用过靠前），不参与匹配。
 */
export interface SavedLoginAccount {
  /** 唯一标识，VBK 的登录账号（vbk_xxx）/ 真实姓名兜底。这两者要在设置面板看起来一致。 */
  accountKey: string;
  /** 真实展示名（vbk_671205 / 小璐）。与 accountKey 在多数场景下相同，缺时回落 accountKey。 */
  accountName: string;
  /** 最近一次被保存到本机的时间（ISO 字符串），用于排序；已被忘记的账号不会出现在这里。 */
  lastUsedAt: string;
}

/**
 * 列举多账号登录态的合并视图：当前 + 已记录。
 * - `current` 为当前 WebView 实际拿到的账号，可能为空（未登录）。
 * - `saved` 是除 current 之外被本机保留的账号。
 * 注意 current 同样也保存在本地；它的 cookies 在 WebView 的 session 里。
 */
export interface LoginAccountsSnapshot {
  current: SavedLoginAccount | null;
  saved: SavedLoginAccount[];
}

/**
 * 账号在本机保存的固定信息。当前两项：400 电话（自由文本）、管家联系人
 * （从 VBK 接口下拉选择，需要保存联系卡 ID 以便后续回填）。地接社名称属于
 * 自动化在 VBK 当前页下拉里选的运行时数据，不属于账号固定信息。
 */
export type AccountFixedInfoFieldKey = "servicePhone" | "butlerName";

export type AccountFixedInfoValue = string | ContactCardSelection;

export interface ContactCardSelection {
  /** VBK 上的联系人卡 ID，用于 selectedContactCardIdList 回填。 */
  contactCardId: number;
  /** 联系人显示名；同时作为设置里给人看的文案。 */
  displayName: string;
  /** 联系人卡所属供应商 ID，调用接口时回传 providerId。 */
  providerId: number;
}

export interface AccountFixedInfoField {
  key: AccountFixedInfoFieldKey;
  label: string;
  placeholder: string;
  /** 输入为空时使用，渲染成「未设置」。 */
  emptyText: string;
  description?: string;
  /** 字段的录入形态：text 是文本框，select 是下拉选择（值由 ContactCardSelection 提供）。 */
  kind: "text" | "select";
}

export interface AccountFixedInfo {
  accountName: string;
  values: Partial<Record<AccountFixedInfoFieldKey, AccountFixedInfoValue>>;
}

/**
 * VBK 接口返回的管家/联系人选项，用于弹窗里下拉展示。
 */
export interface ProviderContactCard {
  contactCardId: number;
  displayName: string;
  providerId: number;
  /** 接口可能附带额外字段（职位、手机号、是否默认等），原样透传给上层。 */
  extra?: Record<string, unknown>;
}
