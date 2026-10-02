import type { SystemNotificationResult } from "../../shared/contracts.js";
import type { AgentAttentionNotification } from "./agent-attention-notification.js";

interface DeliveryState {
  key: string;
  pending: boolean;
  shown: boolean;
  retryAt: number;
}

interface DeliveryOptions {
  supported: () => boolean;
  show: (input: { title: string; body: string }) => Promise<SystemNotificationResult>;
  onFailure: (message: string) => void;
  now?: () => number;
}

/** Expected unsupported environments stay quiet; real failures retry on later events. */
export function createAttentionNotificationDelivery(options: DeliveryOptions) {
  const states = new Map<string, DeliveryState>();
  const now = options.now ?? Date.now;
  const retryDelayMs = 60_000;

  return async (id: string, attention: AgentAttentionNotification): Promise<void> => {
    if (!options.supported()) return;
    const previous = states.get(id);
    if (previous?.pending || (previous?.shown && previous.key === attention.key)
      || (previous && !previous.shown && now() < previous.retryAt)) return;

    const state: DeliveryState = { key: attention.key, pending: true, shown: false, retryAt: 0 };
    states.set(id, state);
    try {
      const result = await options.show({ title: attention.title, body: attention.body });
      state.shown = result.shown;
      if (!result.shown) {
        state.retryAt = now() + retryDelayMs;
        options.onFailure(result.message);
      }
    } catch (error) {
      state.retryAt = now() + retryDelayMs;
      options.onFailure(error instanceof Error ? error.message : String(error));
    } finally {
      state.pending = false;
    }
  };
}
