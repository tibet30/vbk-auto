import { PackageOpen, Settings } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import { WorkbenchModule } from "../../helpers";
import { LoginBrowserPanel } from "./LoginBrowserPanel";
import styles from "./index.module.less";

export function AppWorkspaceHomePage({ model }: { model: AppModel }) {
  const { products, startCreateProduct, openProductList, loginPanelOpen } = model;
  const totalProducts = products.length;
  const hasProducts = totalProducts > 0;
  // 登录打开时，VBK 是唯一任务面：全量展示嵌入式页面，完成后由用户手动确认登录态。
  const stageClass = loginPanelOpen ? styles.homeStageOpen : styles.homeStage;

  return <section className={stageClass} data-login-open={loginPanelOpen ? "true" : "false"}>
    {!loginPanelOpen && <div className={styles.homeMain}>
      <header className={styles.workspaceHomeHead}>
        <h1 className={styles.workspaceHomeTitle}>工作台</h1>
        <p className={shared.viewSub}>从这里启动产品、查看设置或直接进入录入。</p>
      </header>
      <div className={styles.workspaceHomeGrid}>
        <WorkbenchModule
          icon={<PackageOpen size={16} />}
          title="产品"
          detail={
            hasProducts
              ? `当前已建立 ${totalProducts} 个产品，可新增一个或继续处理已有的。`
              : "从新建第一个产品开始，完成后会出现在这里统一管理。"
          }
          state={hasProducts ? "ready" : "emphasis"}
          stateLabel={hasProducts ? "可用" : "推荐"}
          hint={hasProducts ? `共 ${totalProducts} 个产品` : "尚未创建"}
          action={
            <div className={styles.moduleActions}>
              <button
                className={`${shared.btn} ${shared.btnSm}`}
                data-variant="primary"
                onClick={startCreateProduct}
              >
                新建产品
              </button>
              <button
                className={`${shared.btn} ${shared.btnSm}`}
                onClick={openProductList}
              >
                查看产品
              </button>
            </div>
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
    </div>}
    {loginPanelOpen && <LoginBrowserPanel model={model} />}
  </section>;
}
