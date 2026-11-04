import assert from "node:assert/strict";
import test from "node:test";
import { selectAdministrativeCity } from "../../src/main/automation/ctrip/basic-info/administrative-city.js";

const changsha = [
  { cityId: 206, cityName: "长沙", provinceName: "湖南", countryName: "中国" },
  { cityId: 21421, cityName: "长沙县", provinceName: "湖南", countryName: "中国" },
];

test("请求名与平台城市名完全一致时，优先于被短名折叠的县级同名候选", () => {
  assert.equal(selectAdministrativeCity(changsha, "长沙", { province: "湖南" }).cityId, 206);
  assert.equal(selectAdministrativeCity([...changsha].reverse(), "长沙").cityId, 206);
});

test("没有任何候选与请求名完全一致时仍拒绝同名多候选", () => {
  assert.throws(() => selectAdministrativeCity([
    { cityId: 1, cityName: "平遥市" },
    { cityId: 2, cityName: "平遥县" },
  ], "平遥"), /2 个规范候选/);
});

test("多个候选都与请求名完全一致时仍拒绝，不按返回顺序选择", () => {
  assert.throws(() => selectAdministrativeCity([
    { cityId: 1, cityName: "长沙", provinceName: "湖南", countryName: "中国" },
    { cityId: 2, cityName: "长沙", provinceName: "湖南", countryName: "中国" },
  ], "长沙"), /2 个规范候选/);
});
