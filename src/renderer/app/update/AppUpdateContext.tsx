import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AppUpdateState } from "../../../shared/contracts";
import { api } from "../helpers";
import { cleanErrorMessage } from "./update-presentation";

export type AppUpdateBusy = "checking" | "downloading" | "opening" | null;

export interface AppUpdateNotice {
  tone: "error" | "info";
  text: string;
}

export interface AppUpdateContextValue {
  /** 主进程推送的权威状态；首次读取完成前为 null。 */
  state: AppUpdateState | null;
  loading: boolean;
  busy: AppUpdateBusy;
  /** 动作本身的失败（例如安装包文件丢失），与 state.status==="error" 区分开。 */
  notice: AppUpdateNotice | null;
  dialogOpen: boolean;
  openDialog(): void;
  closeDialog(): void;
  dismissNotice(): void;
  check(): Promise<void>;
  download(): Promise<void>;
  openInstaller(): Promise<void>;
  showInstallerInFolder(): Promise<void>;
}

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null);

type Bridge = NonNullable<ReturnType<typeof api>>;

/**
 * 全局唯一的更新状态宿主。挂在登录判断之外，保证未登录时状态栏也能读到
 * 更新进度；同时避免设置页与状态栏各订阅一份 IPC 事件。
 */
export function AppUpdateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<AppUpdateBusy>(null);
  const [notice, setNotice] = useState<AppUpdateNotice | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const stateRef = useRef<AppUpdateState | null>(null);
  const busyRef = useRef<AppUpdateBusy>(null);

  const apply = useCallback((next: AppUpdateState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const fail = useCallback((error: unknown) => {
    apply(fallbackState(error, stateRef.current));
  }, [apply]);

  useEffect(() => {
    const bridge = api();
    if (!bridge?.updates) {
      setLoading(false);
      return;
    }
    let alive = true;
    void bridge.updates
      .status()
      .then((snapshot) => { if (alive) apply(snapshot); })
      .catch((error) => { if (alive) fail(error); })
      .finally(() => { if (alive) setLoading(false); });
    const unsubscribe = bridge.events.onUpdateChanged((snapshot) => apply(snapshot));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [apply, fail]);

  const run = useCallback(
    async (kind: Exclude<AppUpdateBusy, null>, action: (bridge: Bridge) => Promise<AppUpdateState | void>) => {
      const bridge = api();
      if (!bridge?.updates) {
        setNotice({ tone: "error", text: "应用接口尚未就绪，请重启桌面客户端。" });
        return;
      }
      if (busyRef.current) return;
      busyRef.current = kind;
      setBusy(kind);
      setNotice(null);
      try {
        const next = await action(bridge);
        if (next) apply(next);
      } catch (error) {
        setNotice({ tone: "error", text: cleanErrorMessage(error) });
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [apply],
  );

  const value = useMemo<AppUpdateContextValue>(() => ({
    state,
    loading,
    busy,
    notice,
    dialogOpen,
    openDialog: () => { setDialogOpen(true); setNotice(null); },
    closeDialog: () => setDialogOpen(false),
    dismissNotice: () => setNotice(null),
    check: () => run("checking", (bridge) => bridge.updates.check()),
    download: () => run("downloading", (bridge) => bridge.updates.download()),
    openInstaller: () => run("opening", (bridge) => bridge.updates.openInstaller()),
    showInstallerInFolder: () => run("opening", (bridge) => bridge.updates.showInstallerInFolder()),
  }), [busy, dialogOpen, loading, notice, run, state]);

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>;
}

export function useAppUpdate(): AppUpdateContextValue {
  const value = useContext(AppUpdateContext);
  if (!value) throw new Error("useAppUpdate must be used inside AppUpdateProvider");
  return value;
}

function fallbackState(error: unknown, previous: AppUpdateState | null): AppUpdateState {
  return {
    currentVersion: previous?.currentVersion ?? "unknown",
    platform: previous?.platform ?? "darwin",
    supported: previous?.supported ?? false,
    feedUrl: previous?.feedUrl ?? "",
    status: "error",
    updateAvailable: previous?.updateAvailable ?? false,
    availableVersion: previous?.availableVersion,
    releaseDate: previous?.releaseDate,
    downloaded: previous?.downloaded ?? false,
    installerPath: previous?.installerPath,
    checkedAt: previous?.checkedAt,
    errorCode: "unknown",
    errorMessage: cleanErrorMessage(error) || "读取更新状态失败。",
  };
}
