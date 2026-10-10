/**
 * 产品封面保存：
 *   - uploadAndSaveManualCover：手动上传 → 本地副本 → 写 product.presentation.cover；
 *   - saveCtripLibraryCover：携程图库候选 → cover.poi + imageUrl + 元数据；
 *   - clearCover：暂不支持，提示「请改用重新上传 / 重新查询」（为未来接口预留）。
 *
 * 严禁编造：
 *   - 资源组 ID 必须由 VBK 真实匹配；
 *   - 上传后的 cover.fileId 必须先经 main 端 cover:uploadManual 落本地副本。
 */

import type {
  CtripLibraryImageCandidate,
  ManualUploadCoverMeta,
  ProductCover,
} from "../../../../shared/contracts.js";
import { buildCtripLibraryCover, deriveManualCoverFields, readPreviousCover } from "../basic-info-cover-model.js";
import type { AppState } from "../../state/useAppState.js";
import type { UpdateFieldDeps } from "./update-field.js";
import { makeUpdateField } from "./update-field.js";

interface CoverDeps extends UpdateFieldDeps {
  api: typeof import("../../helpers").api;
  product: AppState["product"];
  setBasicInfoErrors: AppState["setBasicInfoErrors"];
  setNotice: AppState["setNotice"];
}

/**
 * 手动上传封面：
 *  1. 先把字节送到 main 端 cover:uploadManual 落本地副本（仅元数据回传）；
 *  2. poi / description / minQuality 由前端根据
 *     a) 旧 cover 同名字段；
 *     b) product.basicInfo.destinationCity / meetingCity；
 *     c) 去掉扩展名的文件名；
 *     d) 「手动上传封面」占位
 *     自动推导，UI 不需要再让运营补字段；
 *  3. 再用 products:updateReviewField 把 meta + 推导字段写入 product.presentation.cover；
 *  4. 上传成功但写入失败时把已上传的 meta 抛错，让 UI 提示运营「重试写入」
 *     而非重新上传。
 */
export function makeUploadAndSaveManualCover(deps: CoverDeps) {
  const {
    api: apiRef,
    product,
    setBasicInfoErrors,
    setNotice,
    savingFieldsRef,
    basicInfoSaving,
  } = deps;
  const updateField = makeUpdateField(deps);
  return async function uploadAndSaveManualCover(
    localProductId: string,
    args: { file: { name: string; type: string; base64: string } },
  ): Promise<ManualUploadCoverMeta | null> {
    const ipc = apiRef();
    if (!ipc) return null;
    if (savingFieldsRef.current.has("cover") || basicInfoSaving === "cover") return null;
    savingFieldsRef.current.add("cover");
    deps.setBasicInfoSaving("cover");
    setBasicInfoErrors((prev) => {
      if (!prev.cover) return prev;
      const next = { ...prev };
      delete next.cover;
      return next;
    });
    try {
      const meta = await ipc.cover.uploadManual({
        originalName: args.file.name,
        mimeType: args.file.type,
        base64: args.file.base64,
      });
      const derived = deriveManualCoverFields({
        previousCover: readPreviousCover(product),
        product: (product?.product ?? {}) as Record<string, unknown>,
        originalName: meta.originalName,
      });
      const cover: ProductCover = {
        source: "manualUpload",
        fileId: meta.fileId,
        originalName: meta.originalName,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes,
        poi: derived.poi,
        description: derived.description,
        minQuality: derived.minQuality,
        uploadedAt: meta.uploadedAt,
      };
      await ipc.products.updateReviewField(localProductId, { field: "productCover", cover });
      return meta;
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存封面失败。";
      setBasicInfoErrors((prev) => ({ ...prev, cover: message }));
      setNotice(`保存封面失败：${message}`);
      return null;
    } finally {
      savingFieldsRef.current.delete("cover");
      deps.setBasicInfoSaving((current) => (current === "cover" ? null : current));
    }
  };
}

/**
 * 把携程图库候选写入 product.presentation.cover：
 *  - 由候选写入 cover.poi，并把候选自带的
 *    imageId / imageUrl（缺一即拒）以及可选的 thumbnailUrl / previewUrl /
 *    score / resolution / poiId / poiName 一起写入；
 *  - candidate 缺 imageId / imageUrl 时设置 basicInfoErrors.cover 与 notice，
 *    返回 false，不调用 updateReviewField，避免空图被持久化；
 *  - poi 兜底 = `携程图库图片 ${imageId}`，尽量保留候选上的
 *    poiName 让 cover 展示更具语义；
 *  - selectedAt = 写入瞬间的 ISO 时间戳，便于审计与对账；
 *  - 成功后由 product:updated 推送回流；失败把错误贴回 UI。
 */
export function makeSaveCtripLibraryCover(deps: CoverDeps) {
  const {
    api: apiRef,
    setBasicInfoErrors,
    setNotice,
    savingFieldsRef,
    basicInfoSaving,
  } = deps;
  return async function saveCtripLibraryCover(
    localProductId: string,
    args: { candidate: CtripLibraryImageCandidate },
  ): Promise<boolean> {
    const ipc = apiRef();
    if (!ipc) return false;
    if (savingFieldsRef.current.has("cover") || basicInfoSaving === "cover") return false;
    savingFieldsRef.current.add("cover");
    deps.setBasicInfoSaving("cover");
    setBasicInfoErrors((prev) => {
      if (!prev.cover) return prev;
      const next = { ...prev };
      delete next.cover;
      return next;
    });
    try {
      const cover = buildCtripLibraryCover(args.candidate);
      await ipc.products.updateReviewField(localProductId, { field: "productCover", cover });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存封面失败。";
      setBasicInfoErrors((prev) => ({ ...prev, cover: message }));
      setNotice(`保存封面失败：${message}`);
      return false;
    } finally {
      savingFieldsRef.current.delete("cover");
      deps.setBasicInfoSaving((current) => (current === "cover" ? null : current));
    }
  };
}

/** 清空产品封面：让 main 端走 cover 移除路径（暂不支持，留接口给未来"清除"按钮）。 */
export function makeClearCover(deps: { api: typeof import("../../helpers").api; setNotice: AppState["setNotice"] }) {
  const { api: apiRef, setNotice } = deps;
  return async function clearCover(localProductId: string): Promise<boolean> {
    const ipc = apiRef();
    if (!ipc) return false;
    // 当前 ManualReviewFieldInput 不接受"清除 cover"；先把 cover 整段从 presentation
    // 删掉需要 products:updateProductJson 走 schema 校验；这里走 patch via updateProductJson
    // 会让 UI 失去 per-field 错误反馈，先暂时禁用并保留接口。后续若需要清除，由 main 端
    // 增加 { field: "productCover", cover: null } 的 contract。
    void localProductId;
    setNotice("暂不支持清除封面，请改用重新上传 / 重新查询并选择。");
    return false;
  };
}