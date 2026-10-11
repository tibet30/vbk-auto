import { PlatformOperationService } from '../application/platform-operation-service.js';
import type { VbkDatabase } from './database/database.js';
import type { PlatformOperationContext } from '../application/platform-operation-service.js';

/** Business query adapter: persistence adds provenance without storing raw provider payloads. */
export function platformResourceGateway(db: VbkDatabase, localProductId: string) {
  const product = db.getProduct?.(localProductId);
  const service = new PlatformOperationService((evidence, status) => db.recordResourceObservation?.(localProductId, { ...evidence, status }));
  return {
    query<T>(capability: string, query: unknown, execute: () => Promise<T>,
      isEmpty?: (value: T) => boolean, source: PlatformOperationContext['source'] = 'vbk') {
      return service.queryValue({ capability, query, accountKey: product?.vbkAccount, source }, execute, isEmpty);
    },
  };
}
