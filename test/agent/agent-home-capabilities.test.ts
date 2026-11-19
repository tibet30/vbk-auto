import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentHome } from "../../src/renderer/app/views/agent/AgentHome.js";
import type { AgentCapabilities } from "../../src/shared/contracts-agent-runtime.js";
import type { AppModel } from "../../src/renderer/app/app.main.model";

const model = {
  startCreateProduct: () => {},
  openProductList: () => {},
  openLogin: () => {},
  setView: () => {},
} as unknown as AppModel;

function render(capabilities?: AgentCapabilities): string {
  return renderToStaticMarkup(createElement(AgentHome, {
    model,
    busy: false,
    capabilities,
    onStart: () => {},
  }));
}

function skills(...ids: string[]): AgentCapabilities {
  return {
    skills: ids.map((id) => ({ id, label: id, description: "", actions: [] })),
    externalTools: [],
  };
}

test("已安装 Skill 的入口可用，未接入的后台入口明确标为尚未接入", () => {
  const html = render(skills("product-read", "deck", "web", "local-file"));
  assert.match(html, /制作 PPT/u);
  assert.match(html, /操作后台/u);
  assert.match(html, /尚未接入/u, "没有后台能力时不能假装可用");
  assert.match(html, /data-state="missing"/u);
  assert.match(html, /disabled/u);
});

test("缺少某个 Skill 时对应入口标为未安装", () => {
  const html = render(skills("product-read", "web"));
  assert.match(html, /未安装/u);
  const deckStart = html.indexOf("制作 PPT");
  const deckSlice = html.slice(deckStart, deckStart + 260);
  assert.match(deckSlice, /data-state="missing"/u, "没有 deck Skill 时不应显示为可用");
});

test("能力未加载完成时入口不冒充可用", () => {
  const html = render(undefined);
  assert.match(html, /data-state="loading"/u);
  assert.doesNotMatch(html, /data-state="ready"/u);
});

test("平台查询入口只在 tibet Skill 就绪时可用", () => {
  const withoutTibet = render(skills("product-read", "deck", "web", "local-file"));
  const ordersStart = withoutTibet.indexOf("查我的订单");
  assert.ok(ordersStart > 0, "入口本身要在，不能悄悄消失");
  assert.match(withoutTibet.slice(ordersStart, ordersStart + 220), /data-state="missing"/u);

  const withTibet = render(skills("product-read", "deck", "web", "local-file", "tibet"));
  const readySlice = withTibet.slice(withTibet.indexOf("查我的订单"), withTibet.indexOf("查我的订单") + 220);
  assert.match(readySlice, /data-state="ready"/u, "有 tibet Skill 时入口必须可用");
  assert.match(withTibet, /查 VBK 绑定/u);
});
