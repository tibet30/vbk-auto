import { ChevronRight } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import { CopyableId, statusLabel } from "../../helpers";
import shared from "../shared.module.less";
import { AccountPopover } from "./AccountPopover";
import styles from "./Topbar.module.less";

/**
 * 44px 顶栏：产品面包屑 / 当前步骤状态 / 账号菜单。
 * VBK 录入的主操作（开始/停止自动录入）已迁移到 VBK 录入页左面板的
 * footer 底部左侧，这里不渲染重复入口。
 * 不渲染主导航 stage-nav，那由 AppShell 直接负责。
 */
export function AppTopbar({ model }: { model: AppModel }) {
  const {
    view,
    product,
    setProduct,
    setView,
    setAccountMenuOpen,
    accountMenuOpen,
    readiness,
    currentAccountName,
    accountInitial,
    vbkLogin,
    openLogin,
    logoutVbk,
    checkingVbkLogin,
  } = model;

  const showProductTools = Boolean(product) && view === "workspace";

  // 非工作台视图下，顶栏左侧显示当前页面名，比写死"VBK Desktop"更符合 macOS
  // 顶栏语义（顶栏 = 当前文档/视图名）。工作台视图下保持原产品面包屑。
  const viewTitle = view === "settings" ? "设置" : view === "operation-log" ? "运行日志" : view === "products" ? "产品" : null;

  return (
    <header className={styles.topbar}>
      <nav className={styles.topbarTitle} aria-label="产品导航">
        {product ? (
          <>
            <button
              className={`${styles.crumb} ${styles.crumbAction}`}
              onClick={() => {
                setProduct(null);
                setView("products");
                setAccountMenuOpen(false);
              }}
              aria-label="返回产品列表"
            >
              <span>产品</span>
            </button>
            <ChevronRight size={13} className={styles.crumbSep} aria-hidden="true" />
            <span
              className={styles.crumbCurrent}
              data-form={product.name.endsWith("跟团游") ? "groupTour" : "privateTour"}
            >
              <strong className={styles.title}>{product.name}</strong>
              <CopyableId value={product.id} className={styles.copyableIdTopbar} />
              <span className={styles.crumbState} data-state={statusTone(product.status)}>
                <span className={shared.dot} data-state={product.status === "blocked" ? "warn" : product.status === "draft_saved" ? "ok" : "ai"} />
                {statusLabel(product.status)}
              </span>
            </span>
          </>
        ) : viewTitle ? (
          <span className={styles.crumb}>{viewTitle}</span>
        ) : null}
      </nav>

      <div className={styles.topbarSpacer} />

      {showProductTools && (
        <>
          <div className={styles.topbarStatusChip} aria-label="方案就绪状态">
            <span
              className={shared.dot}
              data-state={readiness.ready ? "ok" : readiness.issues.length ? "warn" : "ai"}
            />
            <strong>{readiness.completion}%</strong>
            <small>·</small>
            <small>
              {readiness.ready
                ? "可以录入 VBK"
                : `${readiness.issues.length} 项待处理`}
            </small>
          </div>

          <div className={styles.topbarToolRail}>
            <button
          className={styles.topbarAccountChip}
          type="button"
          onClick={() => setAccountMenuOpen((open) => !open)}
          aria-label={`当前 VBK 账号：${currentAccountName}`}
          title={currentAccountName}
          data-account-menu=""
        >
              <span className={styles.topbarAccountMain}>
                <span className={styles.topbarAccountName}>{currentAccountName}</span>
                <span className={shared.dot} data-state={vbkLogin?.loggedIn ? "ok" : "warn"} />
              </span>
            </button>
          </div>
        </>
      )}

      {!product && (
        <div className={styles.topbarStatus}>
          <button
            className={styles.topbarAccountChip}
            type="button"
            onClick={() => setAccountMenuOpen((open) => !open)}
            aria-label={`当前 VBK 账号：${currentAccountName}`}
            title={currentAccountName}
          >
            <span className={styles.topbarAccountMain}>
              <span className={styles.topbarAccountName}>{currentAccountName}</span>
              <span className={shared.dot} data-state={vbkLogin?.loggedIn ? "ok" : "warn"} />
            </span>
          </button>

          {accountMenuOpen && (
            <AccountPopover
              currentAccountName={currentAccountName}
              accountInitial={accountInitial}
              onSwitchLogin={() => {
                setAccountMenuOpen(false);
                openLogin();
              }}
              onLogout={() => void logoutVbk()}
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
              vbkLoggedIn={Boolean(vbkLogin?.loggedIn)}
              logoutDisabled={checkingVbkLogin}
            />
          )}
        </div>
      )}
    </header>
  );
}

function statusTone(status: string): string {
  if (status === "blocked") return "warn";
  if (status === "draft_saved") return "ok";
  return "ai";
}
