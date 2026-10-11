import { AppView } from "./views/AppView";
import { useAppModel } from "./app.main.model";
import { AppAuthProvider, useAppAuthController, useAppAuth } from "./auth/AppAuthContext";
import { workspaceSnapshots } from './state/workspace-snapshot-store';
import { useEffect } from 'react';
import { AppLoginPage } from "./auth/LoginPage";
import { AppFrame } from "./views/shell/AppFrame";
import { AppUpdateProvider } from "./update/AppUpdateContext";

export function App() {
  const auth = useAppAuthController();
  // 更新状态挂在登录判断之外：未登录、登录中、登录失败时底部状态栏同样可用。
  return (
    <AppUpdateProvider>
      <AppFrame>
        {auth.phase === "authenticated" && auth.user ? (
          <AppAuthProvider controller={auth}>
            <AuthenticatedWorkspace key={auth.user.id} />
          </AppAuthProvider>
        ) : (
          <AppLoginPage controller={auth} />
        )}
      </AppFrame>
    </AppUpdateProvider>
  );
}

function AuthenticatedWorkspace() {
  const { user } = useAppAuth();
  workspaceSnapshots.changeOwner(user.id);
  useEffect(() => {
    workspaceSnapshots.changeOwner(user.id);
    return () => workspaceSnapshots.clearOwner(user.id);
  }, [user.id]);
  return <AppView {...useAppModel()} />;
}
