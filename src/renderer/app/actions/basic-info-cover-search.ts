import type {
  CtripLibraryPlaceCandidate,
  CtripLibraryPlaceSearchResult,
  CtripLibrarySearchResult,
} from "../../../shared/contracts.js";
import { api } from "../helpers";

export function createBasicInfoCoverSearchActions(setNotice: (notice: string | null) => void) {
  const searchCtripLibraryPlaces = async (
    localProductId: string,
    args: { keyword: string },
  ): Promise<CtripLibraryPlaceSearchResult | null> => {
    if (!api()) return null;
    const keyword = args.keyword.trim();
    if (!keyword) {
      setNotice("请输入景点名称后再查询。");
      void localProductId;
      return null;
    }
    try {
      return await api()!.cover.searchCtripLibraryPlaces({ keyword });
    } catch (error) {
      setNotice(`查询携程图库地址失败：${error instanceof Error ? error.message : "查询携程图库地址失败。"}`);
      void localProductId;
      return null;
    }
  };

  const searchCtripLibraryImages = async (
    localProductId: string,
    args: { keyword: string; place: CtripLibraryPlaceCandidate },
  ): Promise<CtripLibrarySearchResult | null> => {
    if (!api()) return null;
    const keyword = args.keyword.trim();
    if (!keyword || !args.place || !Number.isInteger(args.place.poiId) || args.place.poiId <= 0) {
      setNotice("请先选择地址后再查询图片。");
      void localProductId;
      return null;
    }
    try {
      return await api()!.cover.searchCtripLibraryImages({ keyword, place: args.place });
    } catch (error) {
      setNotice(`查询携程图库图片失败：${error instanceof Error ? error.message : "查询携程图库图片失败。"}`);
      void localProductId;
      return null;
    }
  };

  return { searchCtripLibraryPlaces, searchCtripLibraryImages };
}
