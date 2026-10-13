export interface HotelDraftRetryPlan {
  token: string;
  localProductId: string;
  productId: string;
  accountKey: string;
  stays: Array<{ cityName: string; nights: number }>;
}
export interface HotelDraftRetryResult {
  verified: true;
  productId: string;
  segmentIds: string[];
  rules: { autoMatch: true; grades: number[] };
  specifiedHotels: [];
  draftOnly: true;
}
