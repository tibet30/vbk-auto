/**
 * 测试辅助：返回深拷贝，并删掉其中所有景点对象上的 spotId。
 *
 * 保存链路会给每个景点补系统生成的随机 spotId；既有断言只关心景点的业务字段，
 * 比较前用它剥掉 ID。可以传单个景点、spots 数组、某一天或整份产品。
 * 只用于断言，不得在生产代码里关闭补 ID。
 */
export function withoutSpotIds<T>(value: T): T {
  return strip(structuredClone(value)) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(strip);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    delete record.spotId;
    Object.values(record).forEach(strip);
  }
  return value;
}
