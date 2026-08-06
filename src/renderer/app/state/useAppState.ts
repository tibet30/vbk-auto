import { useAppStateBase } from "./base";
import { useAppStateDerived } from "./derived";

export function useAppState() {
  const baseState = useAppStateBase();
  const derived = useAppStateDerived(baseState);
  return { ...baseState, ...derived };
}

export type AppState = ReturnType<typeof useAppState>;
