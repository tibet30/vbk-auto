import { LogOut, ShieldCheck, UserRound } from "lucide-react";
import { useState } from "react";
import { useAppAuth } from "../../auth/AppAuthContext";
import shared from "../shared.module.less";
import styles from "./app-account-block.module.less";

function maskPhone(phone: string): string {
  return /^(\d{3})\d+(\d{4})$/.test(phone) ? phone.replace(/^(\d{3})\d+(\d{4})$/, "$1****$2") : phone;
}

export function AppAccountBlock() {
  const { user, logout } = useAppAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try { await logout(); } finally { setLoggingOut(false); }
  };

  return <section className={styles.block} aria-labelledby="app-account-title">
    <div className={styles.heading}>
      <div className={styles.icon}><UserRound size={17} /></div>
      <div>
        <h2 id="app-account-title">应用账号</h2>
        <p>用于进入三人同游，与下方 VBK 店铺账号相互独立。</p>
      </div>
    </div>
    <div className={styles.accountRow}>
      <span className={styles.avatar} aria-hidden="true">{user.name.trim().slice(0, 1) || "用"}</span>
      <div className={styles.identity}>
        <strong>{user.name || "未命名用户"}</strong>
        <span>{maskPhone(user.phone)}</span>
      </div>
      <span className={styles.active}><ShieldCheck size={13} />已验证</span>
      <button className={`${shared.btn} ${shared.btnSm}`} data-variant="secondary" onClick={() => void handleLogout()} disabled={loggingOut}>
        <LogOut size={14} />{loggingOut ? "正在退出" : "退出应用账号"}
      </button>
    </div>
  </section>;
}
