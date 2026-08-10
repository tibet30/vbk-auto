import { useProjectHandlers } from "./project";
import { useWorkflowHandlers } from "./workflow";
import { useAccountHandlers } from "./account";
import { useBasicInfoHandlers } from "./basic-info";
import { useAiHandlers } from "./minimax";
import type { AppState } from "../state/useAppState";

export function useAppActions(state: AppState) {
  const projectActions = useProjectHandlers(state);
  const workflowActions = useWorkflowHandlers(state);
  const accountActions = useAccountHandlers(state);
  const basicInfoActions = useBasicInfoHandlers(state);
  const aiActions = useAiHandlers(state);

  return {
    ...projectActions,
    ...workflowActions,
    ...accountActions,
    ...basicInfoActions,
    ...aiActions,
  };
}

export type AppActions = ReturnType<typeof useAppActions>;
