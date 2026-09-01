import type { AppView } from "./domains/navigation-state.js";

/** 产品与任务集合只在用户真正看到对应列表时读取最新快照。 */
export function shouldRefreshCollections(view: AppView, creatingProduct = false): boolean {
  return view === "tasks" || (view === "products" && !creatingProduct);
}

/** 实时事件只更新当前可见的集合；打开新建表单时保持完全静默。 */
export function shouldApplyCollectionUpdate(view: AppView, creatingProduct = false): boolean {
  return shouldRefreshCollections(view, creatingProduct);
}

/** 后台产品广播只允许更新当前正在查看的详情，不能刷新列表或创建表单。 */
export function shouldApplyProductUpdate(
  view: AppView,
  activeLocalProductId: string | null,
  updatedLocalProductId: string,
): boolean {
  return view === "workspace" && activeLocalProductId === updatedLocalProductId;
}

export function shouldApplyWorkflowTaskDetailUpdate(
  view: AppView,
  activeLocalProductId: string | null,
  taskLocalProductId: string,
): boolean {
  return view === "workspace" && activeLocalProductId === taskLocalProductId;
}

/** 后台 VBK 页面跳转不应在产品表单或列表页触发登录状态刷新。 */
export function shouldHandleVbkPageReady(view: AppView): boolean {
  return view === "workspace";
}
