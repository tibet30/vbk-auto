import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLocalTravelAgency,
  selectAdministrativeCity,
} from "../../src/main/automation/ctrip/basic-info/api.js";
import {
  productLineSaveField,
  resolveBasicInfoCityAnchor,
  selectOptionalProductLine,
  selectProductLine,
} from "../../src/main/automation/ctrip/basic-info/product-line.js";
import { toVbkCityName } from "../../src/shared/region-overrides.js";

const agencies = [
  { localInfoID: 38289, localInfoName: "宾茂乐游", active: "T" },
  { localInfoID: 38207, localInfoName: "宾茂旅业", active: "T" },
  { localInfoID: 99999, localInfoName: "已停用地接社", active: "F" },
];

test("basic API 保留远端已选且可用的地接社", () => {
  assert.deepEqual(resolveLocalTravelAgency({ localInfoID: 38207 }, agencies), {
    id: 38207,
    name: "宾茂旅业",
    selection: "existing",
  });
});

test("basic API 在新草稿未选地接社时使用平台首个可用候选", () => {
  assert.deepEqual(resolveLocalTravelAgency({ localInfoID: 0 }, agencies), {
    id: 38289,
    name: "宾茂乐游",
    selection: "defaulted",
  });
});

test("basic API 不会用任意候选覆盖失效的已选地接社", () => {
  assert.throws(
    () => resolveLocalTravelAgency({ localInfoID: 99999 }, agencies),
    /无法按已选 ID 精确匹配：0 个候选/,
  );
});

test("basic API 在没有可用地接社时明确阻断", () => {
  assert.throws(
    () => resolveLocalTravelAgency({ localInfoID: 0 }, [{ localInfoID: 1, active: "F" }]),
    /未选择且当前账号无可用候选/,
  );
});

test("basic API 用行政短名唯一匹配平台带市尾缀的城市", () => {
  assert.deepEqual(selectAdministrativeCity([
    { cityId: 344775, cityName: "大理石", countryName: "美国" },
    { cityId: 36, cityName: "大理市", provinceName: "云南", countryName: "中国" },
    { cityId: 261270, cityName: "肯尼亚大理石采石场", countryName: "肯尼亚" },
  ], "大理"), {
    cityId: 36,
    cityName: "大理市",
    provinceName: "云南",
    countryName: "中国",
  });
});

test("basic API 复用自治州官方全名到平台短名的精确映射", () => {
  assert.deepEqual(selectAdministrativeCity([
    { cityId: 36, cityName: "大理白族自治州", provinceName: "云南" },
  ], "大理"), { cityId: 36, cityName: "大理白族自治州", provinceName: "云南" });
});

test("basic API 的行政短名匹配仍拒绝同名多候选", () => {
  assert.throws(() => selectAdministrativeCity([
    { cityId: 1, cityName: "平遥市" },
    { cityId: 2, cityName: "平遥县" },
  ], "平遥"), /2 个规范候选/);
  assert.throws(() => selectAdministrativeCity([
    { cityId: 36, cityName: "大理市" },
    { cityId: 37, cityName: "大理白族自治州" },
  ], "大理"), /2 个规范候选/);
});

test("广安的三个真实同名候选按已有四川筛选，排除越南，不按返回顺序选择", () => {
  const cities = [
    { cityId: 807649, cityName: "广安", countryId: 111, countryName: "越南", provinceName: "清化省" },
    { cityId: 697166, cityName: "广安", countryId: 111, countryName: "越南", provinceName: "广宁省" },
    { cityId: 1100, cityName: "广安", countryId: 1, countryName: "中国", provinceName: "四川" },
  ];
  assert.equal(selectAdministrativeCity(cities, "广安", { province: "四川省" }).cityId, 1100);
  assert.throws(() => selectAdministrativeCity(cities.slice(0, 2), "广安", { province: "四川" }),
    /要求中国\/四川\/广安.*实际同名2个.*筛选后0个.*0≠1.*越南\/清化省/);
  assert.throws(() => selectAdministrativeCity([...cities, { ...cities[2], cityId: 123 }], "广安", { province: "四川" }),
    /筛选后2个.*2≠1/);
  assert.throws(() => selectAdministrativeCity(cities, "广安"), /3 个规范候选/);
});

test("潮汕行政城市在平台边界映射汕头，保留本地锁定值并拒绝不一致锚点", () => {
  const product = { basicInfo: { meetingCity: "潮汕", destinationCity: "潮汕" } };
  assert.equal(resolveBasicInfoCityAnchor(product), "汕头");
  assert.equal(product.basicInfo.meetingCity, "潮汕");
  assert.throws(() => resolveBasicInfoCityAnchor({ basicInfo: { meetingCity: "潮汕", destinationCity: "汕头" } }), /同一已锁定城市/);
});

test("万州是重庆下辖区县，平台城市边界映射重庆并保留产品锚点", () => {
  const product = { basicInfo: { meetingCity: "万州", destinationCity: "万州" } };
  assert.equal(resolveBasicInfoCityAnchor(product), "重庆");
  assert.equal(product.basicInfo.meetingCity, "万州");
  assert.equal(toVbkCityName("万州"), "重庆");
  assert.equal(toVbkCityName("重庆"), "重庆");
  assert.equal(toVbkCityName("云阳"), "云阳");
  assert.equal(toVbkCityName(""), "");
});

test("遗留省级城市锚点使用已确认的接送城市自愈", () => {
  assert.equal(resolveBasicInfoCityAnchor({
    basicInfo: { meetingCity: "河南", destinationCity: "河南" },
    operations: { pickupCity: "郑州" },
  }), "郑州");
});

test("正常城市锚点不被接送城市覆盖", () => {
  assert.equal(resolveBasicInfoCityAnchor({
    basicInfo: { meetingCity: "郑州", destinationCity: "郑州" },
    operations: { pickupCity: "洛阳" },
  }), "郑州");
});

test("产品线优先选择平台返回的精确城市一地线路", () => {
  assert.deepEqual(selectProductLine([
    { lineId: 1, lineName: "河南全景" },
    { lineId: 2, lineName: "郑州一地" },
  ], { destinationCity: "河南", province: "河南" }, "郑州"), {
    lineId: 2,
    lineName: "郑州一地",
  });
});

test("省级目的地没有城市一地线路时唯一匹配省内线路", () => {
  assert.deepEqual(selectProductLine([
    { lineId: 10, lineName: "内蒙+东北" },
    { lineId: 11, lineName: "自营专用-吉林省内" },
    { lineId: 12, lineName: "自营专用-吉林市一地" },
  ], { destinationCity: "吉林", province: "吉林省" }, "长春"), {
    lineId: 11,
    lineName: "自营专用-吉林省内",
  });
});

test("城市一地线路只有自营专用前缀版本时唯一匹配", () => {
  assert.deepEqual(selectProductLine([
    { lineId: 10, lineName: "内蒙+东北" },
    { lineId: 11, lineName: "长白山一地" },
    { lineId: 12, lineName: "自营专用-吉林市一地" },
    { lineId: 13, lineName: "主题游-滑雪-松花湖" },
  ], { destinationCity: "吉林", province: "吉林" }, "吉林市"), {
    lineId: 12,
    lineName: "自营专用-吉林市一地",
  });
});

test("精确城市一地线路优先于自营专用前缀版本", () => {
  assert.deepEqual(selectProductLine([
    { lineId: 12, lineName: "自营专用-吉林市一地" },
    { lineId: 14, lineName: "吉林市一地" },
  ], { destinationCity: "吉林", province: "吉林" }, "吉林市"), {
    lineId: 14,
    lineName: "吉林市一地",
  });
});

test("普通城市产品不会降级选择省级全景线路", () => {
  assert.throws(
    () => selectProductLine([
      { lineId: 1, lineName: "河南全景" },
    ], { destinationCity: "郑州", province: "河南" }, "郑州"),
    /平台可选：河南全景/,
  );
});

test("产品线非必填：无法匹配时不写并返回原因，不抛错", () => {
  const result = selectOptionalProductLine([
    { lineId: 10, lineName: "内蒙+东北" },
  ], { destinationCity: "吉林", province: "吉林" }, "吉林市");
  assert.equal(result.productLine, null);
  assert.match(result.skipReason ?? "", /产品线无法按城市\/省份精确匹配：吉林市一地/);
  assert.equal(selectOptionalProductLine([
    { lineId: 12, lineName: "自营专用-吉林市一地" },
  ], { destinationCity: "吉林", province: "吉林" }, "吉林市").productLine?.lineId, 12);
});

test("产品线多候选同样按非必填跳过", () => {
  const result = selectOptionalProductLine([
    { lineId: 1, lineName: "郑州一地" },
    { lineId: 2, lineName: "郑州一地" },
  ], { destinationCity: "郑州", province: "河南" }, "郑州");
  assert.equal(result.productLine, null);
  assert.match(result.skipReason ?? "", /无法唯一匹配：2 个候选/);
});

test("降级保存完全省略 productLineID 字段", () => {
  assert.deepEqual(productLineSaveField(null), {});
  assert.deepEqual(productLineSaveField({ lineId: 11 }), { productLineID: 11 });
});
