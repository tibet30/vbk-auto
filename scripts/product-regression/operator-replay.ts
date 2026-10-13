import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { VbkDatabase } from '../../src/main/infrastructure/database/database.js';
import type { ProductDetail, ManualReviewFieldInput } from '../../src/shared/contracts.js';
import type { ProductMutationService } from '../../src/main/application/product-mutation-service.js';
import { applyManualReviewField } from '../../src/main/operations/manual-review-field.js';
import { storeManualCoverFile } from '../../src/main/infrastructure/database/parts/cover-storage.js';
import { FIXTURE_ROOT, type RegressionFixture, type Json } from './corpus.js';
import type { GenerationReplay } from './generation-replay.js';
import { toPlatformShortLocationName } from '../../src/shared/location-short-name.js';

export function applyInitialOperatorInputs(db: VbkDatabase, mutations: ProductMutationService, id: string, trace: GenerationReplay) {
  const current = db.getProduct(id)!;
  let p = structuredClone(current.product) as Json;
  p.operations = { ...p.operations, ...trace.constraints };
  if (trace.constraints.trafficLine.enabled === false) {
    p.basicInfo.userIdea += '\n禁用大交通。';
  }
  p = applyManualReviewField(p, { field: 'butlerContact', selection: { contactCardId: 1, providerId: 1, displayName: '测试管家' } });
  mutations.commands.mergeChanges(id, current, p, 'user');
  db.addMessage(id, 'user', trace.operatorInstructions);
}

/** Operator actions are applied after the generated draft first becomes visible, through production writes. */
export function operatorReplay(db: VbkDatabase, getMutations: () => ProductMutationService,
  fixture: RegressionFixture, trace: GenerationReplay, dataPath: string) {
  let done = false;
  const actions: string[] = [];
  return { actions, onUpdated: (updated: ProductDetail) => {
    const days = updated.product.itinerary as Json[];
    if (done || !days?.length) return;
    done = true;
    let p = structuredClone(updated.product) as Json;
    for (const { day, requirement } of trace.hotelRequirements) {
      const target = p.itinerary.find((d: Json) => d.day === day);
      if (!target) throw new Error(`住宿输入缺少行程日：${day}`);
      const city = toPlatformShortLocationName(requirement.cityName);
      if (!city) throw new Error(`住宿输入缺少实际行政城市：${day}`);
      target.hotelCity = city;
      actions.push(`hotel-city:${day}`);
    }
    getMutations().commands.mergeChanges(updated.id, db.getProduct(updated.id)!, p, 'user');
    for (const removal of trace.removals) {
      const current = db.getProduct(updated.id)!;
      p = current.product as Json;
      const dayIndex = p.itinerary.findIndex((d: Json) => d.day === removal.day);
      const spotIndex = p.itinerary[dayIndex]?.spots.findIndex((s: Json) => s.name === removal.name);
      if (spotIndex === undefined || spotIndex < 0) throw new Error(`原始生成行程没有待删除项：${removal.name}`);
      getMutations().commands.manualField({ localProductId: updated.id, source: 'user',
        expectedVersion: current.productJsonVersion ?? 0 }, { field: 'itinerarySpotRemove', dayIndex, spotIndex });
      actions.push(`remove:${removal.day}:${removal.name}`);
    }
    if (fixture.manualAsset) {
      const bytes = readFileSync(path.join(FIXTURE_ROOT, fixture.manualAsset.file));
      if (createHash('sha256').update(bytes).digest('hex') !== fixture.manualAsset.sha256) throw new Error('手动封面回放哈希不匹配');
      const original = fixture.product.presentation.cover;
      const meta = storeManualCoverFile({ dataPath, bytes, originalName: original.originalName,
        mimeType: original.mimeType, now: () => new Date('2026-10-11T04:00:00Z') });
      const cover = { ...meta, source: 'manualUpload', poi: original.poi, description: original.description,
        minQuality: original.minQuality, remoteImageId: null } as ManualReviewFieldInput & any;
      const current = db.getProduct(updated.id)!;
      getMutations().commands.manualField({ localProductId: updated.id, source: 'user',
        expectedVersion: current.productJsonVersion ?? 0 }, { field: 'productCover', cover });
      actions.push('manual-cover-upload');
    }
  } };
}
