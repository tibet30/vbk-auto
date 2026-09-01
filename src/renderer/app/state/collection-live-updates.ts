import type { VbkApi } from "../../../shared/contracts.js";
import type { AppStateBase } from "./base.js";
import {
  shouldApplyCollectionUpdate,
  shouldApplyProductUpdate,
  shouldApplyWorkflowTaskDetailUpdate,
} from "./collection-refresh-policy.js";
import { upsertProductToTop } from "./product-list-helper.js";

type LiveUpdateState = Pick<AppStateBase,
  "setProduct" | "setProducts" | "setWorkflowTasks" | "updateReadiness">;

export function subscribeCollectionLiveUpdates(args: {
  events: VbkApi["events"];
  state: LiveUpdateState;
  current: () => { view: AppStateBase["view"]; creating: boolean; localProductId: string | null };
}): () => void {
  const unsubscribeProduct = args.events.onProductUpdated((next) => {
    const current = args.current();
    if (shouldApplyProductUpdate(current.view, current.localProductId, next.id)) {
      args.state.setProduct((product) => product?.id === next.id
        ? { ...next, workflowTask: next.workflowTask ?? product.workflowTask }
        : product);
      void args.state.updateReadiness(next);
    }
    if (shouldApplyCollectionUpdate(current.view, current.creating)) {
      args.state.setProducts((products) => upsertProductToTop(products, next));
    }
  });
  const unsubscribeTask = args.events.onWorkflowTaskUpdated((task) => {
    const current = args.current();
    if (shouldApplyCollectionUpdate(current.view, current.creating)) {
      args.state.setWorkflowTasks((tasks) => [task, ...tasks.filter((item) => item.id !== task.id)]);
      if (current.view === "products") {
        args.state.setProducts((products) => products.map((product) => product.id === task.localProductId
          ? { ...product, workflowTask: task, updatedAt: task.updatedAt }
          : product));
      }
    }
    if (shouldApplyWorkflowTaskDetailUpdate(current.view, current.localProductId, task.localProductId)) {
      args.state.setProduct((product) => product?.id === task.localProductId
        ? { ...product, workflowTask: task }
        : product);
    }
  });
  return () => {
    unsubscribeProduct();
    unsubscribeTask();
  };
}
