import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSnapshot, VbkApi } from "../../../../shared/contracts";

export function useAgentSession(localProductId: string, client: VbkApi | undefined) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot>({ localProductId, run: null, events: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const productRef = useRef(localProductId);
  productRef.current = localProductId;
  const requestBusy = useRef(false);
  const accept = useCallback((next: AgentSnapshot) => {
    if (next.localProductId !== productRef.current) return;
    setSnapshot((current) => {
      if (current.localProductId === next.localProductId
        && Date.parse(current.updatedAt ?? current.run?.updatedAt ?? "") > Date.parse(next.updatedAt ?? next.run?.updatedAt ?? "")) return current;
      return next;
    });
  }, []);
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
  const run = async (action: (agent: VbkApi["agent"]) => Promise<AgentSnapshot>) => {
    if (!client?.agent || requestBusy.current) return null;
    requestBusy.current = true;
    setBusy(true);
    setError(null);
    try { const next = await action(client.agent); accept(next); return next; }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作未完成，请重试"); return null; }
    finally { requestBusy.current = false; setBusy(false); }
  };
  return { snapshot, error, busy, run };
}
