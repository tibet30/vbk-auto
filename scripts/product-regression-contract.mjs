import path from 'node:path';

export const REQUIRED_PRODUCT_SUITES = [
  'test/e2e/product-regression.e2e.test.ts',
  'test/e2e/product-regression-negative.e2e.test.ts',
];
const keys = ['xian', 'chaoshan', 'luzhou', 'chengdu', 'rikaze'];
const faults = ['missing_model', 'missing_resource', 'wrong_poi_match', 'corrupted_saved_match'];
export const REQUIRED_PRODUCT_TESTS = keys.flatMap(key => [
  { file: REQUIRED_PRODUCT_SUITES[0], name: `产品完整 E2E ${key}：原始需求 → 生成 → 筛查 → 保存回读 → 方案确认` },
  ...faults.map(fault => ({ file: REQUIRED_PRODUCT_SUITES[1], name: `产品负向 E2E ${key}/${fault}：生产流程禁止录入审批` })),
]);

/** Unknown file types and extensionless configuration are conservatively included. */
export function requiresProductRegression(root, changedFiles) {
  return changedFiles.some(file => {
    const relative = path.relative(root, path.resolve(root, file)).replaceAll('\\', '/');
    return !['README.md', 'DESIGN.md', 'AGENTS.md'].includes(relative)
      && !/^docs\/.*\.md$/u.test(relative);
  });
}

export function assertProductSuites(root, files) {
  const selected = new Set(files.map(file => path.resolve(root, file)));
  for (const file of REQUIRED_PRODUCT_SUITES) {
    if (!selected.has(path.resolve(root, file))) throw new Error(`缺少强制产品回归文件：${file}`);
  }
}

/** Successful process exit is insufficient: every fixed test must pass once, without skip/todo. */
export function assertProductReceipt(root, records) {
  if (!Array.isArray(records)) throw new Error('缺少产品回归执行记录');
  for (const expected of REQUIRED_PRODUCT_TESTS) {
    const matches = records.filter(record => record.name === expected.name
      && typeof record.file === 'string' && path.resolve(root, record.file) === path.resolve(root, expected.file));
    if (matches.length !== 1 || matches[0].status !== 'test:pass' || matches[0].skip || matches[0].todo) {
      throw new Error(`强制产品回归漏跑、跳过、重复或失败：${expected.name}`);
    }
  }
  if (records.length !== REQUIRED_PRODUCT_TESTS.length) throw new Error('强制产品回归执行数量必须为 25');
}
