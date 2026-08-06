import { api } from "../helpers";
import type { AppState } from "../state/useAppState";

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
    fixedInfoDraft,
    fixedInfoSaving,
    setFixedInfoSaving,
    editingAccount,
  } = state;

  const openAccountEditor = async (accountName: string) => {
    if (!api()) return;
    setEditingAccount(accountName);
    setFixedInfoDraft({});
    setContactCards([]);
    setContactCardSearch("");
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
    // 拉联系人列表；providerId 未记录时由 detectProviderId 在 VBK 页面自动抓。
    try {
      setContactCardsLoading(true);
      const providerId = (await api()!.accounts.providerIdFor(accountName)) ?? (await api()!.accounts.detectProviderId());
      if (providerId) {
        const cards = await api()!.contacts.listProviderContactCards(providerId);
        setContactCards(cards);
      } else {
        setNotice("未能识别当前 VBK 账号的 providerId，请先在 VBK 页面登录并进入主控台。");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "拉取联系人列表失败。");
    } finally {
      setContactCardsLoading(false);
    }
  };

  const closeAccountEditor = () => {
    setEditingAccount(null);
    setFixedInfoSchema([]);
    setFixedInfoDraft({});
    setContactCards([]);
    setContactCardSearch("");
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

  return { openAccountEditor, closeAccountEditor, saveAccountEditor };
}
