import { AppView } from "./views/AppView";
import { useAppModel } from "./app.main.model";
import { AppAuthProvider, useAppAuthController } from "./auth/AppAuthContext";
import { AppLoginPage } from "./auth/LoginPage";

export function App() {
  const auth = useAppAuthController();
  if (auth.phase !== "authenticated") return <AppLoginPage controller={auth} />;
  return (
    <AppAuthProvider controller={auth}>
      <AuthenticatedWorkspace key={auth.user?.id} />
    </AppAuthProvider>
  );
}

function AuthenticatedWorkspace() {
  return <AppView {...useAppModel()} />;
}
