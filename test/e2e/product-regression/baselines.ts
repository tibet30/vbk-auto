import assert from 'node:assert/strict';
import type { RegressionFixture } from '../../../scripts/product-regression/corpus.js';
import type { PreparationEvaluation } from '../../../src/shared/contracts-preparation.js';

// All five representative cases must reach the approval boundary without any VBK write.
export function assertBaseline(fixture: RegressionFixture, evaluation: PreparationEvaluation, issues: string[]) {
  assert.deepEqual(issues, [], `${fixture.key} 资源筛查必须全部成功`);
  assert.deepEqual(evaluation.missing, [], `${fixture.key} 审批前门禁不得阻塞`);
  assert.equal(evaluation.ready, true, `${fixture.key} 必须可以请求 VBK 录入审批`);
}
