"use client";

import { createContext, useContext } from "react";
import type {
  CommunityEvent,
  SharedLocation,
  Location,
  ItineraryResponse,
  RecommendationRequest,
} from "@astana/api-client";
import type { Locale } from "./i18n";

/** In-memory bridge between the persistent planner and group route page. */
export interface SocialPlannerValue {
  locale: Locale;
  allowFixtures: boolean;
  origin: Location | null;
  beginOriginPick: () => void;
  setCommunityEvents: (events: CommunityEvent[]) => void;
  setSharedLocations: (locations: SharedLocation[]) => void;
  /** Returns a validated snapshot, or null when the local form is incomplete. */
  currentRequest: () => RecommendationRequest | null;
  selectedPlaceIds: string[];
  /** Only the /party map shows this route; the local plan stays intact. */
  setSharedItinerary: (itinerary: ItineraryResponse | null) => void;
}

export const SocialPlannerContext = createContext<SocialPlannerValue | null>(
  null,
);

export function useSharedPlanner(): SocialPlannerValue {
  const value = useContext(SocialPlannerContext);
  if (!value) throw new Error("Shared planner must be inside CompassApp");
  return value;
}
