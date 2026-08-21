import { useEffect, useState } from "react";
import { ArrowRight, CircleAlert, Eye, EyeOff, LoaderCircle, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import type { AppAuthCaptcha, AppAuthLoginInput } from "../../../shared/contracts-auth";
import { APP_NAME, LOGO_ALT, LOGO_URL } from "../brand";
import { api } from "../helpers";
import type { AppAuthController } from "./AppAuthContext";
import { appAuthErrorMessage, appAuthLoginError, type AppAuthLoginError } from "./app-auth-error";
import styles from "./LoginPage.module.less";

/**
 * THESIS: 登录是进入运营工作台的安静门禁，不是营销页，也不复刻 VBK 登录。
 * OWN-WORLD: 白色与 zinc 工作台表面、精确边框、单一 teal 状态强调。
 * STORY: 先验证三人同游账号，再进入工作台，VBK 登录留在应用内部完成。
 * FIRST VIEWPORT: 左侧交代两套账号边界，右侧只保留手机号、密码、验证码和主操作。
 * FORM: 建立在现有 Operate 视觉体系上的紧凑双栏登录面，窄屏收为单栏。
 */
export function AppLoginPage({ controller }: { controller: AppAuthController }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [captchaCode, setCaptchaCode] = useState("");
  const [captcha, setCaptcha] = useState<AppAuthCaptcha | null>(null);
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [switchingUserId, setSwitchingUserId] = useState<number | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<AppAuthLoginError | null>(null);

  const loadCaptcha = async () => {
    const bridge = api();
    if (!bridge) {
      setError({ message: "应用接口尚未就绪，请重启桌面客户端。", target: "form" });
      return;
    }
    setCaptchaLoading(true);
    try {
      setCaptcha(await bridge.appAuth.captcha());
      setCaptchaCode("");
    } catch (caught) {
      setCaptcha(null);
      setError({ message: appAuthErrorMessage(caught, "获取验证码失败，请重试。"), target: "form" });
    } finally {
      setCaptchaLoading(false);
    }
  };

  useEffect(() => {
    if (controller.phase === "unauthenticated") void loadCaptcha();
  }, [controller.phase]);

  if (controller.phase === "checking") return <AuthStateScreen mode="checking" onRetry={controller.refresh} />;
  if (controller.phase === "unavailable") {
    return <AuthStateScreen mode="unavailable" message={controller.message} onRetry={controller.refresh} onClear={controller.user ? controller.logout : undefined} />;
  }

  const switchSavedAccount = async (userId: number) => {
    if (switchingUserId !== null || submitting) return;
    setSwitchingUserId(userId);
    setError(null);
    try {
      await controller.switchAccount(userId);
    } catch (caught) {
      setError({
        message: appAuthErrorMessage(caught, "这个账号的登录状态无法恢复，请重新登录。"),
        target: "form",
      });
    } finally {
      setSwitchingUserId(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!captcha) {
      setError({ message: "请先获取图形验证码。", target: "captcha" });
      return;
    }
    setSubmitting(true);
    setError(null);
    const input: AppAuthLoginInput = { phone, password, captchaId: captcha.captchaId, captchaCode };
    try {
      await controller.login(input);
    } catch (caught) {
      setError(appAuthLoginError(caught));
      await loadCaptcha();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className={styles.loginPage}>
      <section className={styles.contextPanel} aria-label="登录说明">
        <div className={styles.brandLockup}>
          <img src={LOGO_URL} alt={LOGO_ALT} />
          <div><strong>{APP_NAME}</strong><span>旅游产品运营工作台</span></div>
        </div>
        <div className={styles.contextBody}>
          <p className={styles.contextKicker}>安全进入工作台</p>
          <h1>先确认操作者，<br />再连接 VBK。</h1>
          <p className={styles.contextCopy}>这里登录的是三人同游应用账号。进入程序后，仍可独立登录或切换 VBK 店铺账号。</p>
          <ol className={styles.boundaryList}>
            <li><span>1</span><div><strong>应用账号</strong><small>控制谁可以进入本机工作台</small></div></li>
            <li><span>2</span><div><strong>VBK 账号</strong><small>控制携程后台读取与产品录入</small></div></li>
          </ol>
        </div>
        <p className={styles.securityNote}><ShieldCheck size={14} />密码不会保存在本机</p>
      </section>

      <section className={styles.formPanel}>
        <form className={styles.loginForm} onSubmit={submit} noValidate>
          <header><h2>登录 {APP_NAME}</h2><p>使用管理员为你开通的运营账号。</p></header>

          {controller.accounts.saved.length > 0 && (
            <section className={styles.savedAccounts} aria-labelledby="saved-app-accounts-title">
              <div className={styles.savedAccountsHead}>
                <strong id="saved-app-accounts-title">以前登录过</strong>
                <span>可直接进入，无需密码</span>
              </div>
              <div className={styles.savedAccountList}>
                {controller.accounts.saved.map((account) => {
                  const name = account.user.name.trim() || "未命名用户";
                  const busy = switchingUserId === account.user.id;
                  return (
                    <button
                      type="button"
                      key={account.user.id}
                      className={styles.savedAccountButton}
                      onClick={() => void switchSavedAccount(account.user.id)}
                      disabled={switchingUserId !== null || submitting}
                      aria-label={`使用 ${name} 进入工作台`}
                    >
                      <span className={styles.savedAccountAvatar} aria-hidden="true">{name.slice(0, 1) || "用"}</span>
                      <span className={styles.savedAccountIdentity}>
                        <strong>{name}</strong>
                        <small>{maskPhone(account.user.phone)}</small>
                      </span>
                      {busy ? <LoaderCircle size={15} className={styles.spin} /> : <ArrowRight size={15} />}
                    </button>
                  );
                })}
              </div>
              <div className={styles.loginDivider}><span>或使用其他账号</span></div>
            </section>
          )}

          <label className={styles.field}>
            <span>手机号</span>
            <input value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
              inputMode="numeric" autoComplete="username" placeholder="请输入 11 位手机号"
              aria-invalid={error?.target === "credentials"} aria-describedby={error?.target === "credentials" ? "app-login-error" : undefined} />
          </label>

          <label className={styles.field}>
            <span>密码</span>
            <div className={styles.passwordField}>
              <input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password" placeholder="请输入密码"
                aria-invalid={error?.target === "credentials"} aria-describedby={error?.target === "credentials" ? "app-login-error" : undefined} />
              <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          <label className={styles.field}>
            <span>图形验证码</span>
            <div className={styles.captchaRow}>
              <input value={captchaCode} onChange={(event) => setCaptchaCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4))}
                autoComplete="off" placeholder="4 位字符" aria-invalid={error?.target === "captcha"}
                aria-describedby={error?.target === "captcha" ? "app-login-error" : undefined} />
              <button type="button" className={styles.captchaImage} onClick={() => void loadCaptcha()} disabled={captchaLoading} aria-label="刷新验证码">
                {captcha ? <img src={captcha.imageDataUrl} alt="图形验证码，点击刷新" /> : <RefreshCw size={17} />}
              </button>
              <button type="button" className={styles.refreshButton} onClick={() => void loadCaptcha()} disabled={captchaLoading} aria-label="刷新验证码">
                <RefreshCw size={15} className={captchaLoading ? styles.spin : undefined} />
              </button>
            </div>
          </label>

          {error && <div id="app-login-error" className={styles.formError} role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>{error.message}</span>
          </div>}
          <button className={styles.submitButton} type="submit" disabled={submitting || captchaLoading || !phone || !password || captchaCode.length !== 4}>
            {submitting ? <><LoaderCircle size={16} className={styles.spin} />正在登录</> : <>进入工作台<ArrowRight size={16} /></>}
          </button>
          <p className={styles.helpText}>没有账号或账号被停用？请联系系统管理员处理。</p>
        </form>
      </section>
    </main>
  );
}

function maskPhone(phone: string): string {
  return /^(\d{3})\d+(\d{4})$/.test(phone)
    ? phone.replace(/^(\d{3})\d+(\d{4})$/, "$1****$2")
    : phone;
}

function AuthStateScreen({ mode, message, onRetry, onClear }: {
  mode: "checking" | "unavailable";
  message?: string;
  onRetry: () => Promise<void>;
  onClear?: () => Promise<void>;
}) {
  return <main className={styles.statePage} aria-live="polite" aria-busy={mode === "checking"}>
    <img src={LOGO_URL} alt={LOGO_ALT} />
    {mode === "checking" ? <LoaderCircle className={styles.spin} size={22} /> : <WifiOff size={22} />}
    <h1>{mode === "checking" ? "正在确认登录状态" : "暂时无法验证账号"}</h1>
    <p>{mode === "checking" ? "有效登录将直接恢复到工作台。" : message}</p>
    {mode === "unavailable" && <div className={styles.stateActions}>
      <button onClick={() => void onRetry()}><RefreshCw size={14} />重新验证</button>
      {onClear && <button data-variant="secondary" onClick={() => void onClear()}>使用其他账号</button>}
    </div>}
  </main>;
}
