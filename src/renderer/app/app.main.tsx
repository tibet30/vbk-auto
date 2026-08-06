import { AppView } from "./views/AppView";
import { useAppModel } from "./app.main.model";

export function App() {
  return <AppView {...useAppModel()} />;
}