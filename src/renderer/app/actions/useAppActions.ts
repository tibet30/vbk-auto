import { useProjectHandlers } from "./project";
import { useWorkflowHandlers } from "./workflow";
import { useAccountHandlers } from "./account";
import { useMiniMaxHandlers } from "./minimax";
import type { AppState } from "../state/useAppState";

export function useAppActions(state: AppState) {
  const projectActions = useProjectHandlers(state);
  const workflowActions = useWorkflowHandlers(state);
  const accountActions = useAccountHandlers(state);
  const miniMaxActions = useMiniMaxHandlers(state);

  return {
    ...projectActions,
    ...workflowActions,
    ...accountActions,
    ...miniMaxActions,
  };
}

export type AppActions = ReturnType<typeof useAppActions>;
