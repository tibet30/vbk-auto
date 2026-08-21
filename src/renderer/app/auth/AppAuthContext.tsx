import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type {
  AppAuthAccountsSnapshot,
  AppAuthLoginInput,
  AppAuthStatus,
  AppAuthUser,
} from "../../../shared/contracts-auth";
import { api } from "../helpers";

export type AppAuthPhase = "checking" | "authenticated" | "unauthenticated" | "unavailable";

export interface AppAuthController {
  phase: AppAuthPhase;
  user: AppAuthUser | null;
  message: string;
  accounts: AppAuthAccountsSnapshot;
  refresh(): Promise<void>;
  login(input: AppAuthLoginInput): Promise<void>;
  switchAccount(userId: number): Promise<void>;
  startLogin(): Promise<void>;
  logout(): Promise<void>;
}

interface AppAuthContextValue {
  user: AppAuthUser;
  accounts: AppAuthAccountsSnapshot;
  switchAccount(userId: number): Promise<void>;
  startLogin(): Promise<void>;
  logout(): Promise<void>;
}

const AppAuthContext = createContext<AppAuthContextValue | null>(null);

function applyStatus(status: AppAuthStatus, setters: {
  setPhase: (phase: AppAuthPhase) => void;
  setUser: (user: AppAuthUser | null) => void;
  setMessage: (message: string) => void;
}) {
  if (status.state === "authenticated") {
    setters.setUser(status.user);
    setters.setMessage("");
    setters.setPhase("authenticated");
  } else if (status.state === "unavailable") {
    setters.setUser(status.cachedUser ?? null);
    setters.setMessage(status.message);
    setters.setPhase("unavailable");
  } else {
    setters.setUser(null);
    setters.setMessage("");
    setters.setPhase("unauthenticated");
  }
}

export function useAppAuthController(): AppAuthController {
  const [phase, setPhase] = useState<AppAuthPhase>("checking");
  const [user, setUser] = useState<AppAuthUser | null>(null);
  const [message, setMessage] = useState("");
  const [accounts, setAccounts] = useState<AppAuthAccountsSnapshot>({ currentUserId: null, saved: [] });
  const setters = useMemo(() => ({ setPhase, setUser, setMessage }), []);

  const refreshAccounts = async () => {
    const bridge = api();
    if (bridge) setAccounts(await bridge.appAuth.listAccounts());
  };

  const refresh = async () => {
    const bridge = api();
    if (!bridge) {
      setPhase("unavailable");
      setMessage("应用接口尚未就绪，请在桌面客户端中重试。");
      return;
    }
    setPhase("checking");
    try {
      applyStatus(await bridge.appAuth.status(), setters);
      await refreshAccounts();
    } catch (error) {
      setPhase("unavailable");
      setMessage(error instanceof Error ? error.message : "暂时无法验证登录状态，请重试。");
    }
  };

  useEffect(() => { void refresh(); }, []);

  return {
    phase,
    user,
    message,
    accounts,
    refresh,
    async login(input) {
      const bridge = api();
      if (!bridge) throw new Error("应用接口尚未就绪，请重启桌面客户端。");
      const status = await bridge.appAuth.login(input);
      applyStatus(status, setters);
      await refreshAccounts();
    },
    async switchAccount(userId) {
      const bridge = api();
      if (!bridge) throw new Error("应用接口尚未就绪，请重启桌面客户端。");
      try {
        const status = await bridge.appAuth.switchAccount(userId);
        // 产品恢复指针属于上一位操作者；账号切换后由新工作台重新拉取产品列表。
        try { localStorage.removeItem("vbk:activeLocalProductId"); } catch { /* unavailable in early Electron boot */ }
        applyStatus(status, setters);
      } finally {
        await refreshAccounts();
      }
    },
    async startLogin() {
      const bridge = api();
      if (!bridge) throw new Error("应用接口尚未就绪，请重启桌面客户端。");
      await bridge.appAuth.startLogin();
      setUser(null);
      setMessage("");
      setPhase("unauthenticated");
      await refreshAccounts();
    },
    async logout() {
      try { await api()?.appAuth.logout(); } finally {
        setUser(null);
        setMessage("");
        setPhase("unauthenticated");
        await refreshAccounts();
      }
    },
  };
}

export function AppAuthProvider({ controller, children }: {
  controller: AppAuthController;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => controller.user ? {
      user: controller.user,
      accounts: controller.accounts,
      switchAccount: controller.switchAccount,
      startLogin: controller.startLogin,
      logout: controller.logout,
    } : null,
    [controller.user, controller.accounts, controller.switchAccount, controller.startLogin, controller.logout],
  );
  if (!value) return null;
  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

export function useAppAuth(): AppAuthContextValue {
  const value = useContext(AppAuthContext);
  if (!value) throw new Error("useAppAuth must be used inside AppAuthProvider");
  return value;
}
