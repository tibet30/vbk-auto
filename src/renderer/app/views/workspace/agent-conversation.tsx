import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, MessageCircleMore, Pause, Play, Send } from "lucide-react";
import type { AgentEvent, ProductDetail, ProductReadiness, VbkApi } from "../../../../shared/contracts";
import { parseProductBriefMessage } from "../../../../shared/product-brief-message";
import { AgentInput } from "./agent-input";
import { groupAgentTimelineEvents } from "./agent-conversation-grouping";
import { AgentAssistantThread, AgentEventItem, STATUS } from "./agent-conversation-items";
import { useAgentSession } from "./use-agent-session";
import shared from "../shared.module.less";
import layout from "./layout.module.less";
import styles from "./agent-conversation.module.less";

const PHASE_NAMES: Record<string, string> = {
  saleControl: "创建草稿", basic: "基础信息", presentation: "产品展示", itinerary: "每日行程", package: "套餐",
  pricingInventory: "价格与库存", hotelResource: "住宿资源", vehicleResource: "用车资源", terms: "条款", trafficLine: "大交通", preflight: "整体核验",
};
function scopeLabel(scope: string) { return PHASE_NAMES[scope.replace("vbk.write_phase:", "")] ?? scope; }

function TimelineItem({ item, events, userName }: {
  item: ReturnType<typeof groupAgentTimelineEvents>[number];
  events: ReturnType<typeof useAgentSession>["snapshot"]["events"];
  userName: string;
}) {
  if (item.kind === "assistant_thread") return <AgentAssistantThread steps={item.steps} events={events} leadingStatus={item.leadingStatus} />;
  return <AgentEventItem event={item.event} events={events} userName={userName} leadingStatus={item.leadingStatus} />;
}

function FailureNotice({ failure, disabled, busy, repairing, submitted, onRepair }: {
  failure: NonNullable<ReturnType<typeof latestAutomationFailure>>;
  disabled: boolean;
  busy: boolean;
  repairing: boolean;
  submitted: boolean;
  onRepair(): void;
}) {
  const canRepairCopy = failure.keywords.length > 0;
  const guidance = canRepairCopy
    ? "已定位到受影响的产品文案。重写时会保留行程、资源、价格和库存。"
    : failure.phase === "pricingInventory"
      ? "请在右侧补全套餐定价与班期库存，再继续录入。"
      : "请根据平台反馈补全对应信息，再继续录入。";
  return <section className={styles.failureNotice} role="alert" aria-label={`${failure.phaseLabel}录入受阻`}>
    <div className={styles.failureHeader}>
      <span className={styles.failureIcon} aria-hidden="true"><CircleAlert size={16} strokeWidth={2.2} /></span>
      <div className={styles.failureHeading}>
        <span>录入受阻</span>
        <strong>{failure.phaseLabel}暂未写入</strong>
      </div>
    </div>
    <div className={styles.failureFeedback}>
      <p>{failure.message}</p>
    </div>
    <div className={styles.failureGuidance}>
      <span>下一步</span>
      <p>{guidance}</p>
    </div>
    {canRepairCopy ? <div className={styles.failureRepair}>
      <span>已加入文案黑名单：{failure.keywords.join("、")}</span>
      <button type="button" className={styles.repairAction} disabled={disabled} onClick={onRepair}>
        {submitted ? "已提交重写" : busy || repairing ? "正在处理…" : "重写受影响的图文"}
      </button>
    </div> : null}
  </section>;
}

export function AgentConversation({ product, userName, readiness, client, input, setInput, onApproved }: {
  product: ProductDetail;
  userName: string;
  readiness: ProductReadiness;
  client: VbkApi | undefined;
  input: string;
  setInput(value: string): void;
  onApproved(): void;
}) {
  const { snapshot, error, busy, run } = useAgentSession(product.id, client);
  const viewport = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const follow = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const [showAbandon, setShowAbandon] = useState(false);
  const [repairingKeywords, setRepairingKeywords] = useState(false);
  const status = snapshot.run?.status;
  const running = status === "running" || status === "queued";
  const approval = snapshot.pendingApproval;
  const request = snapshot.pendingInput;
  const events = snapshot.events;
  const latestEvent = events.at(-1);
  const automationFailure = latestAutomationFailure(product);
  const illegalKeywordRepairRequested = events.some((event) => event.data?.illegalKeywordRepair === true);
  const illegalKeywordRepairSubmitted = illegalKeywordRepairRequested && !automationFailure?.affectedPaths.length;
  const timelineItems = groupAgentTimelineEvents(events);
  const draftKey = `agent-composer:${product.id}`;
  useEffect(() => {
    if (!input) {
      try { const saved = sessionStorage.getItem(draftKey); if (saved) setInput(saved); } catch { /* optional */ }
    }
  }, [draftKey]);
  useEffect(() => { try { sessionStorage.setItem(draftKey, input); } catch { /* optional */ } }, [input, draftKey]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (follow.current) node.scrollTop = node.scrollHeight;
    else setUnseen(true);
  }, [events.length, latestEvent?.id, latestEvent?.content.length, request?.id, approval?.id]);
  const send = async () => {
    if (!input.trim() || busy || composing.current) return;
    const content = input.trim();
    const result = await run((agent) => agent.send(product.id, content));
    if (result) { setInput(""); follow.current = true; }
  };
  const repairIllegalKeywords = async () => {
    if (!automationFailure || busy || repairingKeywords || illegalKeywordRepairSubmitted) return;
    setRepairingKeywords(true);
    try {
      const result = await run((agent) => agent.repairIllegalKeywords(product.id, {
        content: buildIllegalKeywordRepairPrompt(automationFailure),
        keywords: automationFailure.keywords,
        affectedPaths: automationFailure.affectedPaths,
      }));
      if (result) follow.current = true;
    } finally {
      setRepairingKeywords(false);
    }
  };
  return <section className={`${layout.panel} ${styles.panel}`} aria-label="方案对话">
    <div className={layout.panelHeader}>
      <div className={layout.panelTitleRow}><span className={layout.panelNum}>01</span><strong className={layout.panelTitle}>方案协作</strong></div>
      <span className={layout.panelSubLine}>{status ? STATUS[status] : "说说你想做什么"}</span>
    </div>
    <div className={styles.status} role="status"><MessageCircleMore size={15} /><span>{running ? "小助手正在根据结果继续处理，可随时暂停或补充要求" : "在这里沟通和确认，在右侧查看结构化结果"}</span>
      {running && <button type="button" className={styles.pauseAction} disabled={busy} onClick={() => void run((agent) => agent.pause(product.id))}><Pause size={14} />暂停执行</button>}
      {(status === "paused" || status === "failed") && <button type="button" className={styles.pauseAction} disabled={busy} onClick={() => void run((agent) => agent.resume(product.id))}><Play size={14} />继续执行</button>}
    </div>
    <div className={styles.timeline} ref={viewport} role="log" aria-live="polite" onScroll={() => {
      const node = viewport.current;
      if (!node) return;
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
      if (follow.current) setUnseen(false);
    }}>
      {product.messages.map((message) => {
        const brief = message.role === "user" ? parseProductBriefMessage(message.content) : undefined;
        const speaker = message.role === "user" ? userName : "AI";
        const avatar = message.role === "user" ? userName.slice(0, 1) : "AI";
        const avatarClass = message.role === "user" ? styles.messageAvatar : styles.assistantAvatar;
        return <article className={styles.message} key={message.id} data-role={message.role} data-brief={brief ? "true" : undefined} aria-label={`${speaker}的消息`}>
          <span className={styles.messageIdentity} aria-hidden="true"><span className={avatarClass}>{avatar}</span></span>
          {brief ? <dl className={styles.briefFields}>
            <div><dt>目的地</dt><dd>{brief.destination}</dd></div>
            <div><dt>产品形态</dt><dd>{brief.productFormLabel}</dd></div>
            <div><dt>行程</dt><dd>{brief.days} 天 {brief.nights} 晚</dd></div>
            {brief.userIdea ? <div><dt>你的想法</dt><dd>{brief.userIdea}</dd></div> : null}
          </dl> : <div className={styles.messageContent}>{message.content}</div>}
        </article>;
      })}
      {!events.length && !product.messages.length && <p className={styles.empty}>告诉我旅行安排、资源要求，或希望修改的内容。我会结合查询结果完善右侧方案，最后由你确认录入。</p>}
      {timelineItems.map((item) => <TimelineItem key={item.kind === "event" ? item.event.id : item.id} item={item} events={events} userName={userName} />)}
      {request && status === "waiting_input" && <AgentInput key={request.id} request={request} busy={busy} onSubmit={async (response) => { await run((agent) => agent.respond(product.id, response)); }} />}
      {approval?.status === "pending" && status === "waiting_approval" && <section className={styles.approval} aria-label="最终方案确认">
        <strong>确认右侧方案后开始录入</strong>
        <p>{approval.summary}</p>
        <p className={styles.scope}>目标账号：{approval.accountKey}<br />录入范围：{approval.scope.map(scopeLabel).join("、")}</p>
        {!readiness.ready && <p role="status">本地方案尚未准备完成，不能录入：{readiness.issues.slice(0, 3).map((issue) => issue.label).join("、")}</p>}
        <div className={styles.actions}>
          <button type="button" className={shared.btn} data-variant="primary" disabled={busy || !readiness.ready} onClick={async () => {
            const result = await run((agent) => agent.approve(product.id, { approvalId: approval.id, productVersion: approval.productVersion }));
            if (result?.events.some((event) => event.type === "approval" && (event.data?.approvalId ?? (event.data?.approval as { id?: string } | undefined)?.id) === approval.id
              && (event.data?.approval as { status?: string } | undefined)?.status === "approved")) onApproved();
          }}>确认方案并录入 VBK</button>
          <button type="button" className={shared.btn} disabled={busy} onClick={async () => {
            const result = await run((agent) => agent.pause(product.id));
            if (result) document.getElementById("agent-composer")?.focus();
          }}>继续调整</button>
        </div>
      </section>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {automationFailure ? <FailureNotice failure={automationFailure}
        disabled={busy || repairingKeywords || illegalKeywordRepairSubmitted} busy={busy} repairing={repairingKeywords}
        submitted={illegalKeywordRepairSubmitted} onRepair={() => void repairIllegalKeywords()} /> : null}
    </div>
    {unseen && <button className={styles.newMessages} type="button" onClick={() => {
      follow.current = true; setUnseen(false);
      if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
    }}>有新消息 · 回到最新</button>}
    <div className={styles.composer}>
      <textarea id="agent-composer" aria-label="补充你的要求" placeholder="提出需求、补充文案，或继续调整右侧方案…"
        value={input} onChange={(event) => setInput(event.target.value)} rows={3} maxLength={6000}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <div className={styles.actions}>
        {running && <button className={shared.btn} type="button" disabled={busy} onClick={() => void run((agent) => agent.pause(product.id))}><Pause size={14} />暂停执行</button>}
        {(status === "paused" || status === "failed") && <button className={shared.btn} type="button" disabled={busy} onClick={() => void run((agent) => agent.resume(product.id))}><Play size={14} />继续执行</button>}
        {status && !["completed", "abandoned"].includes(status) && <button className={shared.btn} type="button" disabled={busy} onClick={() => setShowAbandon(!showAbandon)}>废弃任务</button>}
        <span className={styles.shortcut}>⌘ / Ctrl + Enter</span>
        <button className={shared.btn} data-variant="primary" type="button" disabled={busy || !input.trim()} onClick={() => void send()}><Send size={14} />{busy ? "提交中…" : "发送"}</button>
      </div>
      {showAbandon && <div className={styles.abandon}>废弃后保留产品和已写入的草稿，当前任务不再恢复。<button type="button" disabled={busy} onClick={async () => { await run((agent) => agent.abandon(product.id)); setShowAbandon(false); }}>确认废弃</button><button type="button" onClick={() => setShowAbandon(false)}>保留任务</button></div>}
    </div>
  </section>;
}

function latestAutomationFailure(product: ProductDetail) {
  const automation = product.automation;
  const phases = Object.values(automation?.recovery?.phases ?? {})
    .filter((phase) => phase.finalError?.trim())
    .sort((a, b) => timestamp(b.attempts.at(-1)?.at) - timestamp(a.attempts.at(-1)?.at));
  const phase = phases[0];
  if (!phase?.finalError) return null;
  const keywords = extractIllegalKeywords(phase.finalError);
  return {
    phaseLabel: scopeLabel(`vbk.write_phase:${phase.phase}`),
    phase: phase.phase,
    message: phase.finalError.trim(),
    keywords,
    affectedPaths: findAffectedPresentationPaths(product.product, keywords),
  };
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractIllegalKeywords(message: string): string[] {
  const words = new Set<string>();
  const pattern = /非法关键词[：:]\s*([^，,、；;\n\r]+)/g;
  for (const match of message.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) words.add(value);
  }
  return [...words];
}

function findAffectedPresentationPaths(product: ProductDetail["product"], keywords: string[]): string[] {
  if (!keywords.length) return [];
  const presentation = product.presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return [];
  const source = presentation as Record<string, unknown>;
  const candidates: Array<[string, unknown]> = [
    ["presentation.recommendation", source.recommendation],
    ["presentation.features", source.features],
  ];
  if (source.cover && typeof source.cover === "object" && !Array.isArray(source.cover)) {
    candidates.push(["presentation.cover.description", (source.cover as Record<string, unknown>).description]);
  }
  if (Array.isArray(source.recommendations)) {
    source.recommendations.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        candidates.push([`presentation.recommendations.${index}.text`, (item as Record<string, unknown>).text]);
      }
    });
  }
  return candidates
    .filter(([, value]) => typeof value === "string" && keywords.some((keyword) => value.includes(keyword)))
    .map(([path]) => path);
}

function buildIllegalKeywordRepairPrompt(failure: NonNullable<ReturnType<typeof latestAutomationFailure>>): string {
  const keywords = failure.keywords.length ? failure.keywords.join("、") : "见上方错误详情";
  const paths = failure.affectedPaths.length ? failure.affectedPaths.join("、") : "presentation 中包含非法关键词的推荐语、推荐理由或产品特色字段";
  return [
    `请处理当前产品${failure.phaseLabel}录入失败。`,
    `平台返回非法关键词：${keywords}。请把这些词作为 VBK 文案黑名单，后续所有可见文案都不要再使用。`,
    `请读取当前产品，只重写这些问题字段：${paths}。不要改用户原始想法、POI 官方名称、行程顺序、资源、价格、库存或联系人。`,
    "请将修复后的 presentation 保存到本地方案，并检查重写结果不再包含上述非法关键词；先不要直接录入 VBK，完成后在对话中说明改了哪些字段，等待我确认后再继续录入。",
  ].join("\n");
}
