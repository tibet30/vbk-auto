import { useState } from "react";
import type {
  AccountFixedInfoField,
  AccountFixedInfoValue,
  LoginAccountsSnapshot,
  ProviderContactCard,
  VbkLoginStatus,
} from "../../../../shared/contracts.js";

export function useAccountBrowserState() {
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");
  const [loginPanelOpen, setLoginPanelOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [fixedInfoSchema, setFixedInfoSchema] = useState<AccountFixedInfoField[]>([]);
  const [fixedInfoDraft, setFixedInfoDraft] = useState<Partial<Record<string, AccountFixedInfoValue>>>({});
  const [fixedInfoSaving, setFixedInfoSaving] = useState(false);
  const [butlerPickerOpen, setButlerPickerOpen] = useState(false);
  const [currentProviderId, setCurrentProviderId] = useState<number | null>(null);
  const [contactCards, setContactCards] = useState<ProviderContactCard[]>([]);
  const [contactCardsLoading, setContactCardsLoading] = useState(false);
  const [contactCardSearch, setContactCardSearch] = useState("");

  const [vbkLogin, setVbkLogin] = useState<VbkLoginStatus | null>(null);
  const [checkingVbkLogin, setCheckingVbkLogin] = useState(false);
  const [vbkLoginAccounts, setVbkLoginAccounts] = useState<LoginAccountsSnapshot>({ current: null, saved: [] });
  const [loadingLoginAccounts, setLoadingLoginAccounts] = useState(false);
  const [fixedInfoReloadToken, setFixedInfoReloadToken] = useState(0);

  return {
    browserOpen, setBrowserOpen,
    browserFullscreen, setBrowserFullscreen,
    browserUrl, setBrowserUrl,
    loginPanelOpen, setLoginPanelOpen,
    accountMenuOpen, setAccountMenuOpen,
    editingAccount, setEditingAccount,
    fixedInfoSchema, setFixedInfoSchema,
    fixedInfoDraft, setFixedInfoDraft,
    fixedInfoSaving, setFixedInfoSaving,
    butlerPickerOpen, setButlerPickerOpen,
    currentProviderId, setCurrentProviderId,
    contactCards, setContactCards,
    contactCardsLoading, setContactCardsLoading,
    contactCardSearch, setContactCardSearch,
    vbkLogin, setVbkLogin,
    checkingVbkLogin, setCheckingVbkLogin,
    vbkLoginAccounts, setVbkLoginAccounts,
    loadingLoginAccounts, setLoadingLoginAccounts,
    fixedInfoReloadToken, setFixedInfoReloadToken,
  };
}
