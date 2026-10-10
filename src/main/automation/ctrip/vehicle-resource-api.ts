/**
 * vehicle-resource-api barrel：15638 系列接口（getSegments / saveSegment / submitSegments /
 * suggestDepartureCity / saveProductMaintainType / createProductDraft）+ 用车资源组绑定主链路。
 *
 * 历史 importer 继续 `import { ensureVehicleResourceApi, saveProductSegmentApi, ... } from
 * "./vehicle-resource-api.js"`，符号由本文件再聚合出去。
 *
 * 子模块：
 *   - types.ts         Segment / ResourceCity / VBK_RESOURCE_HEAD / VehicleResourceBindingOptions；
 *   - segment-helpers  segmentsFromPayload / groupIdOf / hasResourceGroup / resourceGroupDrafts / withoutResourceGroup；
 *   - segment-apis     get / save / suggestDepartureCity / buildLodging / submit / futureSchedule；
 *   - draft-init       ensureResourceSegmentsDraftApi + initializeResourceSegmentsDraftApi；
 *   - vehicle-binding  ensureVehicleResourceApi / ensureVehicleResourceBinding / ensureVehicleResourceGroupDraft /
 *                      verifyVehicleResourceBinding / waitForFormalVehicleResourceBinding。
 */

export type { Segment, ResourceCity, VehicleResourceBindingOptions } from "./vehicle-resource-api/types.js";
export { VBK_RESOURCE_HEAD } from "./vehicle-resource-api/types.js";
export {
  segmentsFromPayload,
  groupIdOf,
  hasResourceGroup,
  resourceGroupDrafts,
  withoutResourceGroup,
} from "./vehicle-resource-api/segment-helpers.js";
export {
  getProductSegmentsApi,
  assertVbkResourceResponse,
  saveProductSegmentApi,
  resolveResourceSegmentCityApi,
  buildLodgingResourceSegment,
  submitResourceSegmentsApi,
  futureSchedule,
} from "./vehicle-resource-api/segment-apis.js";
export {
  ensureResourceSegmentsDraftApi,
  initializeResourceSegmentsDraftApi,
} from "./vehicle-resource-api/draft-init.js";
export {
  verifyVehicleResourceBinding,
  ensureVehicleResourceGroupDraft,
  ensureVehicleResourceBinding,
  ensureVehicleResourceApi,
} from "./vehicle-resource-api/vehicle-binding.js";