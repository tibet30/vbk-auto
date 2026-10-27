/** Exact transfer/assembly instructions. Named venues containing these words
 * remain POIs; a failed lookup never supplies this classification. */
export function isItineraryTransferName(name: string): boolean {
  return /^(?:[\p{Script=Han}]{0,10})?(?:(?:\d{1,2}[:：]\d{2}|\d{1,2}\s*h)\s*)?(?:抵达机场|抵达车站)?(?:接火车站?|火车站接|送火车站?|接站|送站|接机|送机|接团|送团|集合|解散)(?:服务|返程)?$/iu.test(name.trim());
}
