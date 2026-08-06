import { BriefcaseBusiness, Plus, Settings } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import { WorkbenchModule } from "../../helpers";
import styles from "./index.module.less";

export function AppWorkspaceHomePage({ model }: { model: AppModel }) {
  const { projects, startCreateProduct, openProductList } = model;
  const totalProjects = projects.length;

  return <section className={styles.workspaceHome}>
    <header className={styles.workspaceHomeHead}>
      <h1>VBK Desktop 工作台</h1>
      <p className={shared.viewSub}>从这里启动项目、查看设置或直接进入录入。</p>
    </header>
    <div className={styles.workspaceHomeGrid}>
      <WorkbenchModule
        icon={<BriefcaseBusiness size={16} />}
        title="新建项目"
        detail={totalProjects > 0 ? `当前已建立 ${totalProjects} 个项目，继续新增一个` : "先创建第一个产品项目"}
        state="ready"
        action={
          <button className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" onClick={startCreateProduct}>
            <Plus size={14} /> 创建项目
          </button>
        }
      />
      <WorkbenchModule
        icon={<BriefcaseBusiness size={16} />}
        title="项目管理"
        detail="浏览全部项目，打开历史记录并继续处理。"
        state={totalProjects > 0 ? "ready" : "todo"}
        action={
          <button className={`${shared.btn} ${shared.btnSm}`} onClick={openProductList}>
            <BriefcaseBusiness size={14} /> 查看项目
          </button>
        }
      />
      <WorkbenchModule
        icon={<Settings size={16} />}
        title="VBK / MiniMax 设置"
        detail="维护登录与 API Key，确保 AI 与浏览器联动可用。"
        state="todo"
        action={
          <button className={`${shared.btn} ${shared.btnSm}`} onClick={() => { model.setView("settings"); model.setProject(null); }}>
            <Settings size={14} /> 前往设置
          </button>
        }
      />
    </div>
  </section>;
}
