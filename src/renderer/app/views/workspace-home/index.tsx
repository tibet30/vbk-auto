import { BriefcaseBusiness, FolderOpen, Plus, Settings } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import { WorkbenchModule } from "../../helpers";
import { APP_NAME, LOGO_URL, LOGO_ALT } from "../../brand";
import { LoginBrowserPanel } from "./LoginBrowserPanel";
import styles from "./index.module.less";

export function AppWorkspaceHomePage({ model }: { model: AppModel }) {
  const { products, startCreateProduct, openProductList, loginPanelOpen } = model;
  const totalProducts = products.length;
  const hasProducts = totalProducts > 0;
  // 登录面板展开时，专用两列 login stage：左侧普通工作台首页、右侧登录 WebView。
  // loginPanelOpen=true 时 LoginBrowserPanel 始终挂载真实 viewport，关闭由父级卸载。
  const stageClass = loginPanelOpen ? styles.homeStageOpen : styles.homeStage;

  return <section className={stageClass} data-login-open={loginPanelOpen ? "true" : "false"}>
    <div className={styles.homeMain}>
      <header className={styles.workspaceHomeHead}>
        <h1 className={styles.workspaceHomeTitle}>
          <img src={LOGO_URL} alt={LOGO_ALT} className={styles.workspaceHomeLogo} draggable={false} />
          <span>{APP_NAME} 工作台</span>
        </h1>
        <p className={shared.viewSub}>从这里启动产品、查看设置或直接进入录入。</p>
      </header>
      <div className={styles.workspaceHomeGrid}>
        <WorkbenchModule
          icon={<Plus size={16} />}
          title="新建产品"
          detail={hasProducts ? `当前已建立 ${totalProducts} 个产品，继续新增一个。` : "先创建第一个产品，从目的地与天数开始。"}
          state="emphasis"
          stateLabel="推荐"
          hint="3 个字段起步"
          action={
            <button className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" onClick={startCreateProduct}>
              创建产品
            </button>
          }
        />
        <WorkbenchModule
          icon={<FolderOpen size={16} />}
          title="产品管理"
          detail={hasProducts ? "浏览全部产品，打开历史记录并继续处理。" : "还没有任何产品，新建一个后会出现在这里。"}
          state={hasProducts ? "ready" : "todo"}
          stateLabel={hasProducts ? "可用" : "暂无"}
          hint={hasProducts ? `共 ${totalProducts} 个产品` : "—"}
          action={
            <button className={`${shared.btn} ${shared.btnSm}`} onClick={openProductList} disabled={!hasProducts}>
              查看产品
            </button>
          }
        />
        <WorkbenchModule
          icon={<Settings size={16} />}
          title="VBK / AI 模型设置"
          detail="维护登录与 API Key，确保 AI 与浏览器联动可用。"
          state="todo"
          stateLabel="维护"
          hint="登录 + API Key"
          action={
            <button
              className={`${shared.btn} ${shared.btnSm}`}
              onClick={() => {
                model.setView("settings");
                model.setProduct(null);
              }}
            >
              前往设置
            </button>
          }
        />
      </div>
    </div>
    {loginPanelOpen && <LoginBrowserPanel model={model} />}
  </section>;
}
