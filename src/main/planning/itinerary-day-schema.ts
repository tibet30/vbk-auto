import { z } from "zod";
import { isCombinedSpotName } from "./spot-name.js";
import { dayHasUserOtherActivity } from "../../shared/itinerary-content.js";
import { normaliseItinerarySupport } from "../../shared/itinerary-support-arrangements.js";
const requiredText = z.string().trim().min(1);

const itinerarySpotSchema = z.object({
  name: requiredText,
  kind: z.enum(["attraction", "free", "other"]).default("attraction"),
  description: z.string().trim().optional(),
  poiName: z.string().trim().nullable().optional(),
  poiId: z.number().int().positive().nullable().optional(),
  timeOfDay: z.enum(["morning", "afternoon"]).optional(),
  relation: z.enum(["and", "or"]).optional(),
}).strict().superRefine((spot, ctx) => {
  if (spot.kind !== "attraction" && (spot.poiName || spot.poiId)) {
    ctx.addIssue({ code: "custom", path: ["poiId"], message: "自由活动或其他活动不得绑定 POI" });
  }
  if (spot.kind === "attraction" && isCombinedSpotName(spot.name)) {
    ctx.addIssue({
      code: "custom",
      path: ["name"],
      message: "Spot 场所只能指定一个地点；请将组合地点拆分为两个或多个 spots",
    });
  }
});

export const itineraryDaySchema = z.object({
  day: z.number().int().min(1),
  title: requiredText,
  spots: z.array(itinerarySpotSchema),
  activities: z.array(z.object({ time: requiredText, title: requiredText, detail: requiredText,
    type: z.enum(["transport", "visit", "meal", "hotel", "free", "other"]),
    durationMinutes: z.number().positive().optional(), source: z.enum(["user", "ai"]).optional(),
  }).strict()).optional(),
  description: requiredText,
  hotel: z.string().default(""),
  meals: requiredText,
  mealDescriptions: z.array(requiredText).length(3).optional(),
}).strict().superRefine((day, ctx) => {
  if (!normaliseItinerarySupport(day).spots.length && !dayHasUserOtherActivity(day)) ctx.addIssue({ code: "custom", path: ["spots"], message: "无游览站点的日期必须有明确接送或独立活动安排。" });
});
