import { Plus } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import { ProductBriefForm, ProjectList, EmptyProjectState } from "../../helpers";
import styles from "./index.module.less";

/**
 * 产品项目页：标题 + 计数 + 新建按钮，再加项目列表（或新建表单）。
 * 列表本身只承担列表职责，标题由这里独占，避免和外层组件重复渲染。
 */
export function AppProjectsPage({ model }: { model: AppModel }) {
  const {
    projects,
    creating,
    setCreating,
    createInput,
    setCreateInput,
    savingProject,
    createProject,
    deleteProject,
    openProject: openProjectAction,
    setAccountMenuOpen,
    setNotice,
  } = model;

  const openProject = async (item: (typeof projects)[number]) => {
    setNotice(null);
    await openProjectAction(item);
  };

  return (
    <section className={styles.projectsView}>
      <div className={styles.projectViewContainer}>
        <header className={styles.projectPageHead}>
          <div>
            <h1>产品项目</h1>
            <p className={shared.viewSub}>{projects.length} 个项目 · 最近更新优先</p>
          </div>
          {!creating && (
            <button
              className={shared.btn}
              data-variant="primary"
              onClick={() => {
                setAccountMenuOpen(false);
                setCreating(true);
              }}
            >
              <Plus size={14} />
              创建项目
            </button>
          )}
        </header>

        {creating ? (
          <ProductBriefForm
            input={createInput}
            setInput={setCreateInput}
            submitting={savingProject}
            onCancel={() => setCreating(false)}
            onSubmit={() => {
              void createProject();
              setCreating(false);
            }}
          />
        ) : projects.length === 0 ? (
          <EmptyProjectState onCreate={() => setCreating(true)} />
        ) : (
          <ProjectList projects={projects} onOpen={openProject} onDelete={deleteProject} />
        )}
      </div>
    </section>
  );
}
