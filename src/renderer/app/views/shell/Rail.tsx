import { BriefcaseBusiness, History, PackageOpen, Settings } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import { AccountPopover } from "./AccountPopover";
import { LOGO_URL, LOGO_ALT } from "../../brand";
import styles from "./Rail.module.less";

/**
 * 56px 全局侧栏：VBK 标识 + 主导航 + 设置 + 账号菜单。
 * 不负责任何状态；只把事件冒泡给上层。
 */
export function AppRail({ model }: { model: AppModel }) {
  const {
    view,
    setView,
    project,
    setProject,
    setLoginPanelOpen,
    accountMenuOpen,
    setAccountMenuOpen,
    currentAccountName,
    accountInitial,
  } = model;

  const isWorkspace = view === "workspace" && !project;
  const isProjects = view === "projects" || (view === "workspace" && Boolean(project));
  const isOperationLog = view === "operation-log";

  return (
    <aside className={styles.rail} aria-label="主导航">
      <img src={LOGO_URL} alt={LOGO_ALT} className={styles.railMark} draggable={false} />

      <button
        className={styles.railBtn}
        data-active={isWorkspace}
        onClick={() => {
          setProject(null);
          setView("workspace");
          setLoginPanelOpen(false);
        }}
        aria-label="工作台"
        title="工作台"
      >
        <BriefcaseBusiness className={styles.icon} />
      </button>

      <button
        className={styles.railBtn}
        data-active={isProjects}
        onClick={() => {
          setProject(null);
          setView("projects");
          setAccountMenuOpen(false);
        }}
        aria-label="项目"
        title="项目"
      >
        <PackageOpen className={styles.icon} />
      </button>

      <button
        className={styles.railBtn}
        data-active={isOperationLog}
        onClick={() => {
          setProject(null);
          setView("operation-log");
          setAccountMenuOpen(false);
        }}
        aria-label="操作日志"
        title="操作日志"
      >
        <History className={styles.icon} />
      </button>

      <div className={styles.railSpacer} />

      <button
        className={styles.railBtn}
        data-active={view === "settings"}
        onClick={() => {
          setProject(null);
          setView("settings");
          setAccountMenuOpen(false);
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
          onClick={() => setAccountMenuOpen((open) => !open)}
          aria-label={`当前 VBK 账号：${currentAccountName}`}
          title={currentAccountName}
        >
          {accountInitial}
        </button>
        {accountMenuOpen && (
          <AccountPopover
            currentAccountName={currentAccountName}
            accountInitial={accountInitial}
            onSwitchLogin={() => {
              setAccountMenuOpen(false);
              model.openLogin();
            }}
            onLogout={() => void model.logoutVbk()}
            onAddLogin={() => {
              setAccountMenuOpen(false);
              void model.addNewLogin();
            }}
            onSwitchAccount={(accountKey) => {
              setAccountMenuOpen(false);
              void model.switchAccount(accountKey);
            }}
            onForgetAccount={(accountKey) => void model.forgetAccount(accountKey)}
            savedAccounts={model.vbkLoginAccounts?.saved ?? []}
            busyAccountKey={null}
            vbkLoggedIn={Boolean(model.vbkLogin?.loggedIn)}
            logoutDisabled={model.checkingVbkLogin}
          />
        )}
      </div>
    </aside>
  );
}