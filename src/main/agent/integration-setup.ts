import type { MainIpcContext } from '../ipc/context.js';
import { aiProviderConfig, aiProviderLabel as resolveAiProviderLabel } from '../../shared/ai-provider-config.js';
import { OpenAICompatiblePlannerAdapter, planningTransportOptions } from '../planning/adapters/openai-compatible-adapter.js';
import { productNotFound } from '../infrastructure/db-errors.js';
import { AgentCore } from './core.js';
import { OpenAIAgentModel } from './openai-model.js';
import { createAgentBusinessTools, agentProductVersion } from './integration.js';
import { agentPlannerContext, agentTaskContext } from './integration-context.js';
import { agentCompletionGate, approvalForRun } from './integration-gates.js';
import { agentApprovalScopeError, assertAgentWriteAuthorized, normalizeAgentApprovalScope } from './integration-guard.js';
import { reconcileAgentShell } from './integration-reconcile.js';
import { recordAgentUsage } from './integration-usage.js';

/** Wire the loop now; install browser guards when Electron creates its services. */
export function installProductAgent(context: MainIpcContext): () => void {
  const {db,getSettings,apiKey,productWorkflows,remoteProducts,readiness,emitProduct} = context;
  const emitAgentSnapshot = (snapshot: Parameters<NonNullable<MainIpcContext['emitAgentSnapshot']>>[0]) => context.emitAgentSnapshot?.(snapshot);
  context.agentCore = new AgentCore({
    // Resolve credentials and model settings for each Agent turn. Startup remains
    // available without a key, and settings changes apply to the next request.
    modelFor: async (localProductId) => {
      const startedAt = new Date().toISOString();
      const settings = getSettings();
      const profile = aiProviderConfig(settings, settings.aiProvider);
      const key = await apiKey(settings.aiProvider);
      if (!key) throw new Error("请先在设置中配置当前 AI 服务的密钥。");
      return new OpenAIAgentModel({ apiKey: key, baseUrl: profile.baseUrl, model: profile.model,
        onUsage: (usage) => recordAgentUsage(db, localProductId, {
          id: crypto.randomUUID(),source:"chat.reply",stage:"agent",model:profile.model,provider:settings.aiProvider,
          status:"ok",startedAt,endedAt:new Date().toISOString(),durationMs:Date.now()-Date.parse(startedAt),
          inputTokens:usage.inputTokens ?? null,outputTokens:usage.outputTokens ?? null,
          totalTokens:usage.inputTokens!==undefined && usage.outputTokens!==undefined ? usage.inputTokens+usage.outputTokens : null,
        }),
      });
    },
    tools: createAgentBusinessTools({
      db,
      get browser() { return context.browser; },
      get automation() { return context.automation; },
      productWorkflows,
      productMutations: context.productMutations,
      generateStage: async (localProductId, stage) => {
        const settings = getSettings();
        const profile = aiProviderConfig(settings, settings.aiProvider);
        const key = await apiKey(settings.aiProvider);
        if (!key) throw new Error("请先配置 AI 密钥。");
        const product = db.getProduct(localProductId);
        if (!product) throw productNotFound(localProductId);
        const adapter = new OpenAICompatiblePlannerAdapter({ apiKey: key, baseUrl: profile.baseUrl, model: profile.model, ...planningTransportOptions(settings.aiProvider),
          provider: settings.aiProvider, recordUsage: (event) => recordAgentUsage(db, localProductId, event) });
        // The adapter owns the stage-specific function schema. Its context is
        // intentionally a single current-product snapshot for this one-shot run.
        let memoryContext;
        try {
          memoryContext = context.memoryService?.loadContextMemories({ localProductId });
        } catch {
          memoryContext = undefined;
        }
        return adapter.generateStage({ stage, context: agentPlannerContext(product, resolveAiProviderLabel(settings), profile.model,
          (db.getAgentSnapshot(localProductId)?.events ?? []).filter((event) => event.type === "user").map((event) => ({ role: "user" as const, content: event.content })),
          memoryContext) });
      },
      emitProduct,
    }),
    accountFor: async (localProductId) => {
      const product = db.getProduct(localProductId);
      if (!product) throw productNotFound(localProductId);
      const remote = await remoteProducts.get(localProductId);
      const login = await productWorkflows.runVbkPageExclusive(() => context.browser.status(true));
      const accountKey = login.loginAccount?.trim() || login.accountName?.trim();
      if (!login.loggedIn || !accountKey) throw new Error("未验证当前 VBK 登录账号，不能授权或写入。");
      if (remote.vbkAccount && remote.vbkAccount !== accountKey) throw new Error("当前 VBK 账号与产品绑定账号不一致，不能授权或写入。");
      return { accountKey, productVersion: agentProductVersion(product) };
    },
    productFingerprint: async (localProductId) => agentProductVersion(db.getProduct(localProductId)!),
    contextFor: async (localProductId) => {
      let memoryContext;
      try {
        memoryContext = context.memoryService?.loadContextMemories({ localProductId });
      } catch {
        memoryContext = undefined;
      }
      return agentTaskContext(db, localProductId, memoryContext);
    },
    normalizeApprovalScope: (localProductId, scope) => normalizeAgentApprovalScope(db.getProduct(localProductId)!, scope),
    approvalPrecondition: async (localProductId, scope) => {
      const product = db.getProduct(localProductId);
      if (!product) return "产品不存在";
      const scopeError = agentApprovalScopeError(product, scope);
      if (scopeError) return scopeError;
      const result = readiness(localProductId);
      return result.ready ? undefined : `尚未满足 VBK 写入前置条件：${result.issues.slice(0, 3).map((item) => item.label).join("、")}`;
    },
    reconcileUncertainWrite: async (localProductId, uncertain) => productWorkflows.runVbkPageExclusive(async () => {
      const login = await context.browser.status(true);
      const remote = await remoteProducts.get(localProductId);
      const account = login.loginAccount?.trim() || login.accountName?.trim();
      if (!login.loggedIn || !account || (remote.vbkAccount && remote.vbkAccount !== account)) return {reconciled:false,message:"请先登录产品绑定的 VBK 账号再核查。"};
      const product = db.getProduct(localProductId);
      const snapshot = db.getAgentSnapshot(localProductId);
      if (!product || !snapshot) return {reconciled:false,message:"产品记录不存在"};
      const result = await reconcileAgentShell(product, snapshot, uncertain.toolCallId, await context.browser.page());
      if (result.reconciled) {
        const fresh = db.getAgentSnapshot(localProductId)!;
        const event = fresh.events.find(item=>item.type==='tool_result' && item.data?.toolCallId===uncertain.toolCallId);
        if (event) event.data = {...event.data,approvalId:approvalForRun(fresh)?.id,verified:true,phase:result.phase,productId:product.productId};
        else fresh.events.push({id:crypto.randomUUID(),runId:fresh.run!.id,type:"tool_result",createdAt:new Date().toISOString(),content:result.message,data:{toolCallId:uncertain.toolCallId,write:true,remoteWrite:true,approvalId:approvalForRun(fresh)?.id,verified:true,phase:result.phase,productId:product.productId}});
        db.saveAgentSnapshot(fresh);
      }
      return result;
    }),
    // A model cannot declare the run complete after a single write. Completion
    // is accepted only from the durable automation snapshot produced after the
    // platform-side phase readbacks have converged.
    finishVerified: async (localProductId, finishContext) => {
      if (finishContext?.hadRemoteWrites) {
        const login = await productWorkflows.runVbkPageExclusive(() => context.browser.status(true));
        const remote = await remoteProducts.get(localProductId);
        const approval = approvalForRun(db.getAgentSnapshot(localProductId));
        const accountKey = login.loginAccount?.trim() || login.accountName?.trim();
        if (!login.loggedIn || !accountKey || approval?.accountKey!==accountKey || (remote.vbkAccount && remote.vbkAccount!==accountKey)) return {verified:false,message:"当前账号与本轮确认不一致，请恢复对应账号后继续核对。"};
      }
      const product = db.getProduct(localProductId);
      if (!product) return { verified: false, message: "产品不存在" };
      const result = agentCompletionGate(product, db.getAgentSnapshot(localProductId), readiness(localProductId), finishContext);
      if (result.verified && finishContext?.hadRemoteWrites) {
        db.setProductLifecycle(localProductId, {status:"draft_saved"});
        emitProduct(db.getProduct(localProductId)!);
      }
      return result;
    },
  }, {
    getAgentSnapshot: (localProductId) => db.getAgentSnapshot(localProductId),
    saveAgentSnapshot: (snapshot) => { db.saveAgentSnapshot(snapshot); emitAgentSnapshot(snapshot); },
  });
  return () => {
  context.automation.setRunVbkPageExclusive((task) => productWorkflows.runVbkPageExclusive(task));
  context.automation.setAgentWriteGuard(async (localProductId, phase) => {
    const login = await context.browser.status(true);
    const product = db.getProduct(localProductId);
    if (!product || !login.loggedIn) throw new Error("请登录产品对应的 VBK 账号。");
    const remote = await remoteProducts.get(localProductId);
    assertAgentWriteAuthorized({...product,vbkAccount:remote.vbkAccount}, db.getAgentSnapshot(localProductId), phase,
      login.loginAccount?.trim() || login.accountName?.trim() || "");
  });
  };
}
