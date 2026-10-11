import path from 'node:path';
import { REQUIRED_PRODUCT_SUITES } from './product-regression-contract.mjs';

/** Separate from TAP output: collect actual terminal node:test events, never case self-reports. */
export default async function* report(source) {
  const files = new Set(REQUIRED_PRODUCT_SUITES.map(file => path.resolve(file)));
  const records = [];
  for await (const event of source) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    const data = event.data;
    if (!data.file || !files.has(path.resolve(data.file))) continue;
    // Ignore the runner's file-level wrapper; retain every actual test, including unexpected names.
    if (data.name === data.file || path.resolve(data.name) === path.resolve(data.file)) continue;
    records.push({ file: data.file, name: data.name, status: event.type, skip: Boolean(data.skip), todo: Boolean(data.todo) });
  }
  yield JSON.stringify(records);
}
