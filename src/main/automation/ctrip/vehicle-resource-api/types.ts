/**
 * vehicle-resource-api 的对外 / 内部类型与 VBK 通用 head：
 *   - Segment / ResourceCity：通用的 JSON DTO 形状；
 *   - VBK_RESOURCE_HEAD：15638 资源系列接口统一 head；
 *   - VehicleResourceBindingOptions：ensureVehicleResourceBinding 的可选参数。
 */

export type Segment = Record<string, any>;
export type ResourceCity = Record<string, any>;

export const VBK_RESOURCE_HEAD = {
  cid: "",
  ctok: "",
  cver: "1.0",
  lang: "01",
  sid: "8888",
  syscode: "09",
  auth: "",
  xsid: "",
  extension: [],
};

export type VehicleResourceBindingOptions = {
  submitDraft?: boolean;
  formalReadbackAttempts?: number;
  formalReadbackIntervalMs?: number;
};