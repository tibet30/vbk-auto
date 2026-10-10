/**
 * 路由与产品视图切换：
 *   - openProductList：退出当前产品，回到产品列表页；
 *   - startCreateProduct：进入「新建产品」对话框（产品列表页 + 表单初始值）；
 *   - openStage：切换 review / vbk 阶段并收起账号菜单。
 */

import { initialInput } from "../../helpers";
import type { WorkflowDeps } from "./types.js";

export function buildRoutingHandlers(deps: WorkflowDeps) {
  const { state } = deps;
  const {
    setProduct,
    setView,
    setCreating,
    setCreateInput,
    setAutoConfirmCreation,
    setAccountMenuOpen,
    setStage,
  } = state;

  /** 退出当前产品，回到产品列表页。 */
  const openProductList = () => {
    setProduct(null);
    setView("products");
    setCreating(false);
    setAccountMenuOpen(false);
  };

  /** 进入"新建产品"对话框（产品列表页 + 表单初始值）。 */
  const startCreateProduct = () => {
    setProduct(null);
    setView("products");
    setCreating(true);
    setCreateInput(initialInput);
    setAutoConfirmCreation(false);
    setAccountMenuOpen(false);
  };

  const openStage = (next: "review" | "vbk") => {
    setStage(next);
    setAccountMenuOpen(false);
  };

  return { openProductList, startCreateProduct, openStage };
}