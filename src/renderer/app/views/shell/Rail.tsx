import { BriefcaseBusiness, History, PackageOpen, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppModel } from "../../app.main.model";
import { useAppAuth } from "../../auth/AppAuthContext";
import { AppAccountPopover } from "./AppAccountPopover";
import { LOGO_URL, LOGO_ALT } from "../../brand";
import styles from "./Rail.module.less";

/**
 * 56px 全局侧栏：VBK 标识 + 主导航 + 设置 + 账号菜单。
 * 不负责任何状态；只把事件冒泡给上层。
 */
export function AppRail({ model }: { model: AppModel }) {
  const { user, accounts, switchAccount, startLogin, logout } = useAppAuth();
  const [appAccountMenuOpen, setAppAccountMenuOpen] = useState(false);
  const {
    view,
    setView,
    product,
    setProduct,
    setLoginPanelOpen,
    setAccountMenuOpen,
  } = model;

  const appUserName = user.name.trim() || "未命名用户";
  const appUserInitial = appUserName.slice(0, 1) || "用";

  useEffect(() => {
    if (!appAccountMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-app-account-menu]")) return;
      setAppAccountMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAppAccountMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [appAccountMenuOpen]);

  const closeAccountMenus = () => {
    setAppAccountMenuOpen(false);
    setAccountMenuOpen(false);
  };

  const isWorkspace = view === "workspace" && !product;
  const isProducts = view === "products" || (view === "workspace" && Boolean(product));
  const isOperationLog = view === "operation-log";

  return (
    <aside className={styles.rail} aria-label="主导航">
      <img src={LOGO_URL} alt={LOGO_ALT} className={styles.railMark} draggable={false} />

      <button
        className={styles.railBtn}
        data-active={isWorkspace}
        onClick={() => {
          setProduct(null);
          setView("workspace");
          setLoginPanelOpen(false);
          closeAccountMenus();
        }}
        aria-label="工作台"
        title="工作台"
      >
        <BriefcaseBusiness className={styles.icon} />
      </button>

      <button
        className={styles.railBtn}
        data-active={isProducts}
        onClick={() => {
          setProduct(null);
          setView("products");
          closeAccountMenus();
        }}
        aria-label="产品"
        title="产品"
      >
        <PackageOpen className={styles.icon} />
      </button>

      <button
        className={styles.railBtn}
        data-active={isOperationLog}
        onClick={() => {
          setProduct(null);
          setView("operation-log");
          closeAccountMenus();
        }}
        aria-label="运行日志"
        title="运行日志"
      >
        <History className={styles.icon} />
      </button>

      <div className={styles.railSpacer} />

      <button
        className={styles.railBtn}
        data-active={view === "settings"}
        onClick={() => {
          setProduct(null);
          setView("settings");
          closeAccountMenus();
        }}
        aria-label="设置"
        title="设置"
      >
        <Settings className={styles.icon} />
      </button>

      <div className={styles.railAccountWrap}>
        <button
          className={styles.railAccount}
          type="button"
          onClick={() => {
            setAccountMenuOpen(false);
            setAppAccountMenuOpen((open) => !open);
          }}
          aria-label={`当前登录用户：${appUserName}`}
          aria-expanded={appAccountMenuOpen}
          aria-controls="app-account-popover"
          title={appUserName}
          data-app-account-menu=""
        >
          {appUserInitial}
        </button>
        {appAccountMenuOpen && (
          <AppAccountPopover
            user={user}
            savedAccounts={accounts.saved}
            onSwitchAccount={async (userId) => {
              await switchAccount(userId);
              setAppAccountMenuOpen(false);
            }}
            onStartLogin={startLogin}
            onLogout={logout}
          />
        )}
      </div>
    </aside>
  );
}
