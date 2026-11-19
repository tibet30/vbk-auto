// 三人同游只读 Skill 测试的共享夹具：owner、上下文、空页与可覆盖的读取端口。
import type { AgentSkillContext, TibetReadPort } from "../../src/main/agent-runtime/index.js";

const OWNER = 1001;
const context: AgentSkillContext = { ownerUserId: OWNER, threadId: "t-1", runId: "r-1" };

const emptyPage = { items: [] as never[], total: 0, page: 1, pageSize: 20 };

function port(overrides: Partial<TibetReadPort> = {}): TibetReadPort {
  return {
    status: async () => ({ configured: true, message: "" }),
    listServices: async () => emptyPage,
    getService: async () => ({ publicId: "172708729898149707", title: "示例服务" }),
    listAdminServices: async () => emptyPage,
    listVbkBindings: async () => ({ items: [], activeVbkAccountKey: null }),
    listOrders: async () => [],
    getOrder: async () => ({ publicId: "223016566171929308", orderNo: "223016566171929308", status: "paid" }),
    productReference: async () => ({ configured: true, title: "示例产品", cities: ["成都"], matches: [], message: "" }),
    ...overrides,
  };
}
export { OWNER, context, emptyPage, port };
