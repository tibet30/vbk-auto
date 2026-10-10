import type { HotelStayRequirement } from "../../shared/hotel-stay-requirement.js";
export type HotelSearchContext = {
  id: string;
  cityId: number;
  cityName: string;
  name: string;
  coordinate: { latitude: number; longitude: number };
  requirement?: HotelStayRequirement;
};
