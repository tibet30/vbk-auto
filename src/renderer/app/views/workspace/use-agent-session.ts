import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDisplaySnapshot, AgentHistoryPage, VbkApi } from "../../../../shared/contracts";
import { agentHistoryPage } from "../../../../shared/agent-display";

export function shouldReplaceVisibleHistoryOnSnapshot(page: number): boolean {
  return page === 0;
}

export function shouldApplyHistoryResponse(expectedProductId: string, currentProductId: string, responseSequence: number, currentSequence: number): boolean {
  return expectedProductId === currentProductId && responseSequence === currentSequence;
}

export function useAgentSession(localProductId: string, client: VbkApi | undefined) {
  const [snapshot, setSnapshot] = useState<AgentDisplaySnapshot>({ localProductId, run: null, events: [], eventCount: 0 });
  const [history, setHistory] = useState<AgentHistoryPage>(() => agentHistoryPage([], 0));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const productRef = useRef(localProductId);
  const acceptedUpdatedAt = useRef("");
  const historyRef = useRef(history);
  const historyRequestSequence = useRef(0);
  productRef.current = localProductId;
  const requestBusy = useRef(false);
  const replaceHistory = useCallback((next: AgentHistoryPage) => {
    historyRef.current = next;
    setHistory(next);
  }, []);
  const accept = useCallback((next: AgentDisplaySnapshot) => {
    if (next.localProductId !== productRef.current) return;
    const nextUpdatedAt = next.updatedAt ?? next.run?.updatedAt ?? "";
    if (Date.parse(acceptedUpdatedAt.current) > Date.parse(nextUpdatedAt)) return;
    acceptedUpdatedAt.current = nextUpdatedAt;
    setSnapshot(next);
    if (!shouldReplaceVisibleHistoryOnSnapshot(historyRef.current.page)) return;
    replaceHistory({
      events: next.events,
      page: 0,
      pageCount: Math.max(1, Math.ceil(next.eventCount / 120)),
      olderEventCount: Math.max(0, next.eventCount - next.events.length),
      newerEventCount: 0,
    });
  }, [replaceHistory]);
  useEffect(() => {
    acceptedUpdatedAt.current = "";
    historyRequestSequence.current += 1;
    setSnapshot({ localProductId, run: null, events: [], eventCount: 0 });
    replaceHistory(agentHistoryPage([], 0));
  }, [localProductId, replaceHistory]);
  useEffect(() => {
    if (!client?.agent) return;
    let alive = true;
    let broadcastRevision = 0;
    const unsubscribe = client.events.onAgentUpdated((next) => {
      if (next.localProductId !== localProductId || !alive) return;
      broadcastRevision += 1;
      accept(next);
    });
    const refresh = async () => {
      const before = broadcastRevision;
      try {
        const next = await client.agent.get(localProductId);
        if (alive && before === broadcastRevision) accept(next);
      } catch (reason) { if (alive) setError(reason instanceof Error ? reason.message : "无法读取协作记录"); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { alive = false; window.clearInterval(timer); unsubscribe(); };
  }, [client, localProductId, accept]);
  const loadHistoryPage = async (page: number) => {
    if (!client?.agent) return;
    const expectedProductId = localProductId;
    const responseSequence = historyRequestSequence.current + 1;
    historyRequestSequence.current = responseSequence;
    try {
      const next = await client.agent.getHistory(expectedProductId, page);
      if (shouldApplyHistoryResponse(expectedProductId, productRef.current, responseSequence, historyRequestSequence.current)) replaceHistory(next);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取历史沟通记录"); }
  };
  const run = async (action: (agent: VbkApi["agent"]) => Promise<AgentDisplaySnapshot>) => {
    if (!client?.agent || requestBusy.current) return null;
    requestBusy.current = true;
    setBusy(true);
    setError(null);
    try { const next = await action(client.agent); accept(next); return next; }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作未完成，请重试"); return null; }
    finally { requestBusy.current = false; setBusy(false); }
  };
  return { snapshot, history, error, busy, run, loadHistoryPage };
}
