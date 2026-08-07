import { CircleCheck, CircleX, LoaderCircle, Search, UserSearch, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
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
    butlerPickerOpen,
    openButlerPicker,
    closeButlerPicker,
    searchContactCards,
    butlerSearchDebounceMs,
    fixedInfoSaving,
    closeAccountEditor,
    saveAccountEditor,
  } = model;

  const selectedButlerName = useMemo(() => asContactCard(fixedInfoDraft.butlerName), [fixedInfoDraft.butlerName]);
  const phoneValue = typeof fixedInfoDraft.servicePhone === "string" ? fixedInfoDraft.servicePhone : "";

  // 搜索动作通过 ref 避开 useEffect deps —— searchContactCards 随 model spread
  // 每次都是新引用，不进 deps 可避免每次 re-render 都重置计时器。
  const searchContactCardsRef = useRef(searchContactCards);
  searchContactCardsRef.current = searchContactCards;

  // 搜索 debounce：只对「搜索词 / picker 开关」两个语义变量产生响应，
  // 计时器会被反复重置直到用户连续 300ms 不再输入，才真正请求一次。
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!butlerPickerOpen) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      searchContactCardsRef.current(contactCardSearch);
    }, butlerSearchDebounceMs);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [contactCardSearch, butlerPickerOpen, butlerSearchDebounceMs]);

  if (!editingAccount) return null;

  const pickButler = (card: ContactCardSelection) => {
    setFixedInfoDraft((draft) => ({
      ...draft,
      butlerName: {
        contactCardId: card.contactCardId,
        providerId: card.providerId,
        displayName: card.displayName,
      },
    }));
    closeButlerPicker();
  };

  const clearButler = () => {
    setFixedInfoDraft((draft) => {
      const next = { ...draft };
      delete next.butlerName;
      return next;
    });
    closeButlerPicker();
  };

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
                {!butlerPickerOpen ? (
                  <>
                    <div className={styles.fieldHead}>
                      <span className={shared.fieldLabel}>{field.label}</span>
                      {selectedButlerName ? (
                        <div className={styles.fieldHeadActions}>
                          <button
                            type="button"
                            className={`${shared.btn} ${shared.btnSm}`}
                            onClick={openButlerPicker}
                          >
                            <UserSearch size={12} /> 更换
                          </button>
                          <button
                            type="button"
                            className={`${shared.btn} ${shared.btnSm}`}
                            data-variant="ghost"
                            onClick={clearButler}
                          >
                            清除
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={`${shared.btn} ${shared.btnSm}`}
                          data-variant="primary"
                          onClick={openButlerPicker}
                        >
                          <UserSearch size={12} /> 选择管家联系人
                        </button>
                      )}
                    </div>
                    {selectedButlerName ? (
                      <div className={styles.contactCardPicked}>
                        <span>
                          <strong>{selectedButlerName.displayName}</strong>
                          <small>{`contactCardId: ${selectedButlerName.contactCardId} · providerId: ${selectedButlerName.providerId}`}</small>
                        </span>
                      </div>
                    ) : (
                      <div className={styles.contactCardEmpty}>{field.emptyText}</div>
                    )}
                  </>
                ) : (
                  <div className={styles.contactCardPicker}>
                    <div className={styles.contactCardPickerHead}>
                      <span className={shared.fieldLabel}>{field.label}</span>
                      <button
                        type="button"
                        className={`${shared.btn} ${shared.btnSm}`}
                        data-variant="ghost"
                        onClick={closeButlerPicker}
                      >
                        <X size={12} /> 收起选择
                      </button>
                    </div>
                    <div className={styles.contactCardSearch} data-loading={contactCardsLoading ? "true" : undefined}>
                      <Search size={14} aria-hidden="true" className={styles.contactCardSearchIcon} />
                      <input
                        className={styles.contactCardSearchInput}
                        autoFocus
                        placeholder="按姓名搜索"
                        value={contactCardSearch}
                        onChange={(event) => setContactCardSearch(event.target.value)}
                      />
                      {contactCardSearch && !contactCardsLoading && (
                        <button
                          type="button"
                          className={styles.contactCardSearchClear}
                          onClick={() => setContactCardSearch("")}
                          aria-label="清空搜索"
                          title="清空"
                        >
                          <X size={12} />
                        </button>
                      )}
                      {contactCardsLoading && <LoaderCircle size={14} className={styles.spinner} aria-hidden="true" />}
                    </div>

                    {contactCards.length > 0 ? (
                      <ul className={styles.contactCardList}>
                        {contactCards.map((card) => {
                          const isPicked = selectedButlerName?.contactCardId === card.contactCardId;
                          return (
                            <li key={card.contactCardId}>
                              <button
                                type="button"
                                className={styles.contactCardItem}
                                data-picked={isPicked ? "true" : "false"}
                                onClick={() => pickButler(card)}
                              >
                                <span>
                                  <strong>{card.displayName}</strong>
                                  <small>{`contactCardId: ${card.contactCardId} · providerId: ${card.providerId}`}</small>
                                </span>
                                {isPicked ? <CircleCheck size={14} /> : <UserSearch size={13} className={styles.itemPickHint} />}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : contactCardsLoading ? (
                      <p className={styles.contactCardHint}>正在从 VBK 拉取联系人…</p>
                    ) : contactCardSearch.trim() ? (
                      <p className={styles.contactCardHint}>没有匹配「{contactCardSearch.trim()}」的联系人。</p>
                    ) : (
                      <p className={styles.contactCardHint}>该 providerId 下暂无联系人；若还未在 VBK 登录，请先登录后返回。</p>
                    )}
                  </div>
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