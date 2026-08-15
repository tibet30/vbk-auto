import { Plus } from "lucide-react";
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
    savingProduct,
    createProduct,
    deleteProduct,
    openProduct: openProductAction,
    setAccountMenuOpen,
    setNotice,
    settings,
  } = model;

  const aiConfigured = hasActiveAiKey(settings);
  const aiProviderName = aiProviderLabel(settings);

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
            <p className={shared.viewSub}>{products.length} 个产品 · 最近更新优先</p>
          </div>
          {!creating && (
            <button
              className={shared.btn}
              data-variant="primary"
              onClick={() => {
                setAccountMenuOpen(false);
                if (!aiConfigured) {
                  setNotice(`尚未配置 AI 模型，请先到「设置」中配置 ${aiProviderName} 的 API Key 后再创建产品。`);
                  return;
                }
                setCreating(true);
              }}
            >
              <Plus size={14} />
              创建产品
            </button>
          )}
        </header>

        {creating ? (
          <ProductBriefForm
            input={createInput}
            setInput={setCreateInput}
            submitting={savingProduct}
            onCancel={() => setCreating(false)}
            onSubmit={() => {
              void createProduct();
              setCreating(false);
            }}
          />
        ) : products.length === 0 ? (
          <EmptyProductState aiConfigured={aiConfigured} providerLabel={aiProviderName} />
        ) : (
          <ProductList products={products} onOpen={openProduct} onDelete={deleteProduct} />
        )}
      </div>
    </section>
  );
}
