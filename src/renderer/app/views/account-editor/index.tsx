import { CircleCheck, CircleX, LoaderCircle, Search } from "lucide-react";
import { useMemo } from "react";
import type { ContactCardSelection } from "../../../../shared/contracts.js";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./index.module.less";

function asContactCard(value: unknown): ContactCardSelection | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    contactCardId?: unknown;
    providerId?: unknown;
    displayName?: unknown;
  };
  if (
    typeof raw.contactCardId !== "number"
    || typeof raw.providerId !== "number"
    || typeof raw.displayName !== "string"
  ) return null;
  return {
    contactCardId: raw.contactCardId,
    providerId: raw.providerId,
    displayName: raw.displayName,
  };
}

function contactCardMatches(list: readonly ContactCardSelection[], keyword: string) {
  const query = keyword.trim().toLowerCase();
  if (!query) return list;
  return list.filter((card) => card.displayName.toLowerCase().includes(query));
}

export function AppAccountEditor({ model }: { model: AppModel }) {
  const {
    editingAccount,
    fixedInfoSchema,
    fixedInfoDraft,
    setFixedInfoDraft,
    contactCards,
    contactCardsLoading,
    contactCardSearch,
    setContactCardSearch,
    fixedInfoSaving,
    closeAccountEditor,
    saveAccountEditor,
  } = model;

  const selectedButlerName = useMemo(() => asContactCard(fixedInfoDraft.butlerName), [fixedInfoDraft.butlerName]);
  const filteredContactCards = useMemo(
    () => contactCardMatches(contactCards, contactCardSearch),
    [contactCards, contactCardSearch],
  );
  const phoneValue = typeof fixedInfoDraft.servicePhone === "string" ? fixedInfoDraft.servicePhone : "";

  if (!editingAccount) return null;

  return <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label={`编辑 ${editingAccount} 的账号固定信息`}>
    <section className={styles.modal}>
      <header className={styles.modalHead}>
        <div>
          <strong>编辑账号固定信息</strong>
          <small>当前账号：{editingAccount}</small>
        </div>
        <button className={shared.iconBtn} type="button" onClick={closeAccountEditor} aria-label="关闭"><CircleX size={16} /></button>
      </header>
      <div className={styles.modalBody}>
        {fixedInfoSchema.map((field) => {
          if (field.key === "servicePhone") {
            return (
              <label className={styles.field} key={field.key}>
                <span className={shared.fieldLabel}>{field.label}</span>
                <input
                  className={shared.input}
                  autoComplete="off"
                  placeholder={field.placeholder}
                  value={phoneValue}
                  onChange={(event) => setFixedInfoDraft((draft) => ({ ...draft, servicePhone: event.target.value }))}
                />
                <small className={shared.fieldHint}>{field.emptyText}</small>
              </label>
            );
          }

          if (field.key === "butlerName") {
            return (
              <div className={styles.field} key={field.key}>
                <span className={shared.fieldLabel}>{field.label}</span>
                {contactCardsLoading && (
                  <div className={styles.contactCardLoading}><LoaderCircle size={14} />正在从 VBK 拉取联系人…</div>
                )}
                {selectedButlerName ? (
                  <div className={styles.contactCardPicked}>
                    <span>
                      <strong>{selectedButlerName.displayName}</strong>
                      <small>{`contactCardId: ${selectedButlerName.contactCardId} · providerId: ${selectedButlerName.providerId}`}</small>
                    </span>
                    <button
                      className={`${shared.btn} ${shared.btnSm}`}
                      data-variant="ghost"
                      type="button"
                      onClick={() => {
                        setFixedInfoDraft((draft) => {
                          const next = { ...draft };
                          delete next.butlerName;
                          return next;
                        });
                      }}
                    >
                      清除
                    </button>
                  </div>
                ) : (
                  <div className={styles.contactCardEmpty}>{field.emptyText}。</div>
                )}
                <div className={styles.contactCardSearch}>
                  <Search size={14} />
                  <input
                    className={shared.input}
                    placeholder="按姓名筛选"
                    value={contactCardSearch}
                    onChange={(event) => setContactCardSearch(event.target.value)}
                  />
                </div>
                {filteredContactCards.length > 0 ? (
                  <div className={styles.contactCardList}>
                    {filteredContactCards.map((card) => (
                      <button
                        type="button"
                        className={styles.contactCardItem}
                        key={card.contactCardId}
                        onClick={() => setFixedInfoDraft((draft) => ({
                          ...draft,
                          butlerName: {
                            contactCardId: card.contactCardId,
                            providerId: card.providerId,
                            displayName: card.displayName,
                          },
                        }))}
                      >
                        <span>
                          <strong>{card.displayName}</strong>
                          <small>{`contactCardId: ${card.contactCardId} · providerId: ${card.providerId}`}</small>
                        </span>
                        <CircleCheck size={13} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className={shared.taskEmpty} style={{ marginTop: 6 }}>
                    暂无联系人。若还未在 VBK 登录，请先登录后返回。
                  </p>
                )}
              </div>
            );
          }

          return null;
        })}
      </div>
      <footer className={styles.modalFoot}>
        <div />
        <div className={styles.modalFootBtnRow}>
          <button className={`${shared.btn} ${shared.btnSm}`} onClick={closeAccountEditor} disabled={fixedInfoSaving}>
            取消
          </button>
          <button className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" disabled={fixedInfoSaving} onClick={() => void saveAccountEditor()}>
            {fixedInfoSaving ? <LoaderCircle size={14} /> : <CircleCheck size={14} />}
            保存
          </button>
        </div>
      </footer>
    </section>
  </div>;
}
