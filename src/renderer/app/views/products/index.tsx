import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { aiProviderLabel, hasActiveAiKey } from "../../../../shared/contracts.js";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import { ProductBriefForm, ProductList, EmptyProductState } from "../../helpers";
import styles from "./index.module.less";

/**
 * 产品列表页：标题 + 计数 + 新建按钮，再加产品列表（或新建表单）。
 * 列表本身只承担列表职责，标题由这里独占，避免和外层组件重复渲染。
 */
export function AppProductsPage({ model }: { model: AppModel }) {
  const {
    products,
    creating,
    setCreating,
    createInput,
    setCreateInput,
    autoConfirmCreation,
    setAutoConfirmCreation,
    savingProduct,
    createProduct,
    deleteProduct,
    openProduct: openProductAction,
    setAccountMenuOpen,
    setNotice,
    settings,
    vbkLogin,
    vbkLoginAccounts,
    refreshVbkLoginAccounts,
  } = model;
  const [selectedVbkAccount, setSelectedVbkAccount] = useState("all");
  const [page, setPage] = useState(1);

  const aiConfigured = hasActiveAiKey(settings);
  const aiProviderName = aiProviderLabel(settings);
  useEffect(() => {
    void refreshVbkLoginAccounts();
  }, [refreshVbkLoginAccounts]);
  const vbkAccounts = useMemo(() => {
    const entries = [
      ...(vbkLogin?.loginAccount ? [{ key: vbkLogin.loginAccount, label: vbkLogin.accountName ?? vbkLogin.loginAccount }] : []),
      ...(vbkLoginAccounts.current ? [{ key: vbkLoginAccounts.current.accountKey, label: vbkLoginAccounts.current.accountName }] : []),
      ...vbkLoginAccounts.saved.map((entry) => ({ key: entry.accountKey, label: entry.accountName })),
    ];
    return Array.from(new Map(entries.map((entry) => [entry.key, entry])).values());
  }, [vbkLogin, vbkLoginAccounts]);
  const visibleProducts = useMemo(() => {
    const filtered = selectedVbkAccount === "all"
      ? products
      : products.filter((item) => item.vbkAccount === selectedVbkAccount);
    return [...filtered].sort((a, b) => {
      const timeDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      return timeDiff || b.id.localeCompare(a.id);
    });
  }, [products, selectedVbkAccount]);
  const pageCount = Math.max(1, Math.ceil(visibleProducts.length / 10));
  const pagedProducts = visibleProducts.slice((page - 1) * 10, page * 10);

  useEffect(() => {
    if (selectedVbkAccount !== "all" && !vbkAccounts.some((entry) => entry.key === selectedVbkAccount)) {
      setSelectedVbkAccount("all");
    }
  }, [selectedVbkAccount, vbkAccounts]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const openProduct = async (item: (typeof products)[number]) => {
    setNotice(null);
    await openProductAction(item);
  };

  return (
    <section className={styles.productsView}>
      <div className={styles.productViewContainer}>
        <header className={styles.productPageHead}>
          <div>
            <h1>产品列表</h1>
            <p className={shared.viewSub}>{visibleProducts.length} 个产品 · 最近更新优先</p>
          </div>
          {!creating && <div className={styles.productHeadActions}>
            <label className={styles.vbkFilter}>
              <select
                className={shared.input}
                aria-label="按 VBK 账号筛选产品"
                value={selectedVbkAccount}
                onChange={(event) => {
                  setSelectedVbkAccount(event.target.value);
                  setPage(1);
                }}
              >
                <option value="all">全部账号</option>
                {vbkAccounts.map((entry) => (
                  <option key={entry.key} value={entry.key}>{entry.label}（{entry.key}）</option>
                ))}
              </select>
            </label>
            <button
              className={shared.btn}
              data-variant="primary"
              onClick={() => {
                setAccountMenuOpen(false);
                if (!aiConfigured) {
                  setNotice(`尚未配置 AI 模型，请先到「设置」中配置 ${aiProviderName} 的 API Key 后再创建产品。`);
                  return;
                }
                setAutoConfirmCreation(false);
                setCreating(true);
              }}
            >
              <Plus size={14} />
              创建产品
            </button>
          </div>}
        </header>

        {creating ? (
          <ProductBriefForm
            input={createInput}
            setInput={setCreateInput}
            autoConfirm={autoConfirmCreation}
            setAutoConfirm={setAutoConfirmCreation}
            submitting={savingProduct}
            onCancel={() => {
              setCreating(false);
              setAutoConfirmCreation(false);
            }}
            onSubmit={() => {
              void createProduct();
            }}
          />
        ) : products.length === 0 ? (
          <EmptyProductState aiConfigured={aiConfigured} providerLabel={aiProviderName} />
        ) : visibleProducts.length === 0 ? (
          <p className={shared.sectionEmpty}>当前筛选的 VBK 账号暂无产品。</p>
        ) : (
          <>
            <ProductList products={pagedProducts} onOpen={openProduct} onDelete={deleteProduct} />
            {pageCount > 1 && (
              <nav className={styles.productPagination} aria-label="产品列表分页">
                <button
                  className={shared.iconBtn}
                  type="button"
                  aria-label="上一页"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft size={15} />
                </button>
                <span>第 {page} / {pageCount} 页</span>
                <button
                  className={shared.iconBtn}
                  type="button"
                  aria-label="下一页"
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                  disabled={page === pageCount}
                >
                  <ChevronRight size={15} />
                </button>
              </nav>
            )}
          </>
        )}
      </div>
    </section>
  );
}
