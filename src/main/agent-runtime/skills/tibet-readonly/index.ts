/**
 * 三人同游服务端（Tibet）只读 Skill。
 *
 * 只注册 `read` 动作：令牌自检、公共目录、后台目录、VBK 绑定、客户订单。
 * 任何写入（创建/编辑/上下架/吊销）都不在这里——写动作必须走动作计划 → 审批 → 收据，
 * 并且要同时具备 preview 与 reconcile。
 *
 * 权限边界写进代码：服务端把「公共接口」和「个人数据接口」分开，令牌按类型绑定身份
 * （客户 / 扩展用户 / 管理员）。读不到时如实报错（抛给执行器记 failed 收据），
 * 绝不把 403「没权限」写成「没有数据」。
 */

import type { AgentSkill } from "../../types.js";
import {
  adminServicesAction,
  orderDetailAction,
  ordersAction,
  productReferenceAction,
  serviceDetailAction,
  servicesAction,
  statusAction,
  vbkBindingsAction,
} from "./actions.js";
import type { TibetReadPort } from "./port.js";

export { TIBET_READ_ACCOUNT } from "./port.js";
export type {
  TibetAdminCatalogQueryRecord,
  TibetCatalogDetailRecord,
  TibetCatalogPageRecord,
  TibetCatalogQueryRecord,
  TibetCatalogServiceRecord,
  TibetOrderRecord,
  TibetPlatformReferenceRecord,
  TibetReadPort,
  TibetStatusRecord,
  TibetVbkBindingRecord,
} from "./port.js";

export function createTibetReadSkill(port: TibetReadPort): AgentSkill {
  return {
    id: "tibet",
    label: "三人同游服务端（只读）",
    description: "读取三人同游服务端的令牌状态、在售/后台服务目录、VBK 账号绑定、客户订单，并按产品比对平台在售参考价；只读，不执行任何服务端写入。",
    actions: [
      statusAction(port),
      servicesAction(port),
      adminServicesAction(port),
      serviceDetailAction(port),
      vbkBindingsAction(port),
      ordersAction(port),
      orderDetailAction(port),
      productReferenceAction(port),
    ],
  };
}
