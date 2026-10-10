/**
 * itinerary-input-contract 入口（barrel）：
 *   - utils.ts：DAY_TOKEN + 通用归一工具（asDayList / asRecord / text / unique /
 *     spotNames / spotName / samePlace / isNameSubsequence / missingNames /
 *     extraNames / isDeletableAdministrativeLocation / isSupportingLockedSpot /
 *     requiresLockedAttraction / escapeRegExp / userMessages / shortCity）；
 *   - mode.ts：classifyItineraryInputMode + coversAllDays；
 *   - alternative.ts：explicitAlternativeGroups + rawAlternativeGroups +
 *     cleanAlternativeName + uniqueGroups + explicitAlternativeGroupError +
 *     hasTrustedOperatorAlternativeDeletion + hasTrustedOperatorAlternativeDeletionOnAnyDay；
 *   - contract.ts：itineraryInputContractError + planningWriteContractError（主入口）。
 */

export { classifyItineraryInputMode, coversAllDays } from "./itinerary-input-contract/mode.js";
export {
  explicitAlternativeGroupError,
  explicitAlternativeGroups,
  hasTrustedOperatorAlternativeDeletion,
  hasTrustedOperatorAlternativeDeletionOnAnyDay,
  rawAlternativeGroups,
  cleanAlternativeName,
  uniqueGroups,
} from "./itinerary-input-contract/alternative.js";
export {
  itineraryInputContractError,
  planningWriteContractError,
} from "./itinerary-input-contract/contract.js";
export {
  asDayList,
  asRecord,
  text,
  unique,
  shortCity,
  userMessages,
  spotNames,
  spotName,
  samePlace,
  isNameSubsequence,
  missingNames,
  extraNames,
  isDeletableAdministrativeLocation,
  isSupportingLockedSpot,
  requiresLockedAttraction,
  escapeRegExp,
  DAY_TOKEN,
} from "./itinerary-input-contract/utils.js";