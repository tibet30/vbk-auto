import { useAppState } from "./state/useAppState";
import { useAppActions } from "./actions/useAppActions";

export function useAppModel() {
  const state = useAppState();
  const actions = useAppActions(state);
  return { ...state, ...actions };
}

export type AppModel = ReturnType<typeof useAppModel>;
