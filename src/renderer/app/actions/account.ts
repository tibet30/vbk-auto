import { api } from "../helpers";
import type { AppState } from "../state/useAppState";

const BUTLER_SEARCH_DEBOUNCE_MS = 300;

export function useAccountHandlers(state: AppState) {
  const {
    setEditingAccount,
    setFixedInfoSchema,
    setFixedInfoDraft,
    setContactCards,
    setContactCardSearch,
    setContactCardsLoading,
    setNotice,
    setActiveTaskId,
    setButlerPickerOpen,
    setCurrentProviderId,
    fixedInfoDraft,
    fixedInfoSaving,
    setFixedInfoSaving,
    editingAccount,
    currentProviderId,
    contactCardSearch,
  } = state;

  // 进入账号编辑器：只读取 schema + fixedInfo，不预拉联系人列表。
  // 管家联系人采用懒加载：点开「选择管家联系人」后才发起请求。
  const openAccountEditor = async (accountName: string) => {
    if (!api()) return;
    setEditingAccount(accountName);
    setFixedInfoDraft({});
    setContactCards([]);
    setContactCardSearch("");
    setButlerPickerOpen(false);
    setCurrentProviderId(null);
    try {
      const [schema, info] = await Promise.all([
        api()!.accounts.fixedInfoSchema(),
        api()!.accounts.getFixedInfo(accountName),
      ]);
      setFixedInfoSchema(schema);
      setFixedInfoDraft({ ...info.values });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取账号固定信息失败。");
      setEditingAccount(null);
      return;
    }
    // 静默获取 providerId（仅用于后续管家搜索时不重复发起 detect）；
    // 失败不阻断编辑器打开。
    try {
      const providerId = (await api()!.accounts.providerIdFor(accountName))
        ?? (await api()!.accounts.detectProviderId());
      if (providerId) setCurrentProviderId(providerId);
    } catch {
      /* providerId 缺失不影响主流程；选择管家时会再尝试 detect。 */
    }
  };

  const closeAccountEditor = () => {
    setEditingAccount(null);
    setFixedInfoSchema([]);
    setFixedInfoDraft({});
    setContactCards([]);
    setContactCardSearch("");
    setButlerPickerOpen(false);
    setCurrentProviderId(null);
  };

  const openButlerPicker = async () => {
    if (!api()) return;
    // 保证 providerId 可用；缺则再尝试一次 detect。
    let providerId = currentProviderId;
    if (!providerId) {
      try {
        providerId = (await api()!.accounts.detectProviderId()) ?? null;
        if (providerId) setCurrentProviderId(providerId);
      } catch {
        providerId = null;
      }
    }
    if (!providerId) {
      setNotice("未能识别当前 VBK 账号的 providerId，请先在 VBK 页面登录并进入主控台。");
      return;
    }
    // 仅打开 picker；首次查询由 modal 内 useEffect 监听 butlerPickerOpen 触发，
    // 避免「手动查 + effect 查」重复请求。
    setButlerPickerOpen(true);
  };

  const closeButlerPicker = () => {
    setButlerPickerOpen(false);
    setContactCards([]);
    setContactCardSearch("");
  };

  /**
   * 执行一次管家联系人搜索。300ms debounce 由 modal 内 useEffect 负责，
   * 此函数本身不做节流。
   */
  const runButlerSearch = async (providerId: number, keyword: string) => {
    if (!api()) return;
    setContactCardsLoading(true);
    try {
      const cards = await api()!.contacts.listProviderContactCards(providerId, keyword.trim());
      setContactCards(cards);
    } catch (error) {
      setContactCards([]);
      setNotice(error instanceof Error ? error.message : "拉取联系人列表失败。");
    } finally {
      setContactCardsLoading(false);
    }
  };

  const searchContactCards = (keyword: string) => {
    if (!api() || !currentProviderId) return;
    void runButlerSearch(currentProviderId, keyword);
  };

  const saveAccountEditor = async () => {
    if (!editingAccount || !api()) return;
    setFixedInfoSaving(true);
    try {
      await api()!.accounts.saveFixedInfo(editingAccount, fixedInfoDraft);
      setNotice("账号固定信息已保存。");
      closeAccountEditor();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setFixedInfoSaving(false);
    }
  };

  return {
    openAccountEditor,
    closeAccountEditor,
    openButlerPicker,
    closeButlerPicker,
    searchContactCards,
    butlerSearchDebounceMs: BUTLER_SEARCH_DEBOUNCE_MS,
    saveAccountEditor,
  };
}