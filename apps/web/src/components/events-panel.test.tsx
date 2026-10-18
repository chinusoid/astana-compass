import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  CommunityEvent,
  SocialState,
  SocialActionRequest,
} from "@astana/api-client";
import EventsPanel from "./events-panel";
import {
  SocialPlannerContext,
  type SocialPlannerValue,
} from "@/lib/shared-planner";
import { eventText } from "@/lib/events-copy";
import { valid } from "@/lib/contracts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const state: SocialState = {
  profile: { id: "guest-a", name: "Aida" },
  friend_code: "ABCD2345",
  friends: [],
  friend_requests: [],
  party_invites: [],
  parties: [],
  expires_at: "2026-10-20T12:00:00Z",
};
const event: CommunityEvent = {
  id: "event-a",
  title: "Sketch walk",
  description: "Bring a pencil",
  location: { lat: 51.09, lon: 71.42 },
  starts_at: "2026-10-19T07:00:00Z",
  ends_at: "2026-10-19T08:00:00Z",
  author: state.profile,
  is_verified: false,
  created_at: "2026-10-18T12:00:00Z",
};
function context(
  overrides: Partial<SocialPlannerValue> = {},
): SocialPlannerValue {
  return {
    locale: "ru",
    allowFixtures: false,
    origin: event.location,
    beginOriginPick: vi.fn(),
    currentRequest: () => null,
    selectedPlaceIds: [],
    setSharedItinerary: vi.fn(),
    setSharedLocations: vi.fn(),
    setCommunityEvents: vi.fn(),
    ...overrides,
  };
}
function panel(value: SocialPlannerValue) {
  return (
    <SocialPlannerContext.Provider value={value}>
      <EventsPanel
        initialStart="2026-10-19T12:00"
        initialEnd="2026-10-19T13:00"
      />
    </SocialPlannerContext.Provider>
  );
}

it("publishes the selected point with Astana timestamps, labels it unverified and deletes only the user's event", async () => {
  expect(valid("SocialState", state)).toBe(true);
  expect(valid("CommunityEvents", { events: [event] })).toBe(true);
  const stranger = {
    ...event,
    id: "event-b",
    title: "Other person's event",
    author: { id: "guest-b", name: "Daniyar" },
  };
  let events: CommunityEvent[] = [stranger];
  const actions: SocialActionRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/events")) return Response.json({ events });
      if (url.endsWith("/state")) return Response.json(state);
      const action = JSON.parse(String(init?.body)) as SocialActionRequest;
      actions.push(action);
      if (action.action === "event_create")
        events = [
          ...events,
          { ...event, title: action.title, description: action.description },
        ];
      if (action.action === "event_delete")
        events = events.filter((item) => item.id !== action.event_id);
      return Response.json(state);
    }),
  );
  const value = context();
  const user = userEvent.setup();
  const { unmount } = render(panel(value));
  await user.type(
    await screen.findByRole("textbox", { name: eventText("ru", "title") }),
    "Sketch walk",
  );
  await user.type(
    screen.getByRole("textbox", { name: eventText("ru", "description") }),
    "Bring a pencil",
  );
  expect(
    screen.queryByRole("button", { name: eventText("ru", "delete") }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: eventText("ru", "publish") }),
  );
  await screen.findByText(eventText("ru", "published"));
  expect(actions[0]).toEqual({
    action: "event_create",
    title: "Sketch walk",
    description: "Bring a pencil",
    location: event.location,
    starts_at: "2026-10-19T07:00:00.000Z",
    ends_at: "2026-10-19T08:00:00.000Z",
  });
  const own = (
    await screen.findByRole("heading", { name: "Sketch walk" })
  ).closest("article")!;
  expect(within(own).getByText(eventText("ru", "unverified"))).toBeVisible();
  expect(within(own).getByText(/Aida/)).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: eventText("ru", "delete") }),
  ).toHaveLength(1);
  await user.click(
    within(own).getByRole("button", { name: eventText("ru", "delete") }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "Sketch walk" }),
    ).not.toBeInTheDocument(),
  );
  expect(actions[1]).toEqual({ action: "event_delete", event_id: "event-a" });
  expect(value.setCommunityEvents).toHaveBeenLastCalledWith([stranger]);
  unmount();
  expect(value.setCommunityEvents).toHaveBeenLastCalledWith([]);
});

it("offers a real session link without inventing a signed-in identity", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/state")
        ? Response.json(
            { error: { code: "session_required" } },
            { status: 401 },
          )
        : Response.json({ events: [] }),
    ),
  );
  render(panel(context({ origin: null })));
  expect(
    await screen.findByRole("link", { name: eventText("ru", "openParty") }),
  ).toHaveAttribute("href", "/party");
  expect(
    screen.queryByRole("button", { name: eventText("ru", "publish") }),
  ).not.toBeInTheDocument();
});

it("rejects an end before the start without posting an event", async () => {
  const fetcher = vi.fn(async (url: string) =>
    Response.json(url.endsWith("/state") ? state : { events: [] }),
  );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(
    <SocialPlannerContext.Provider value={context()}>
      <EventsPanel
        initialStart="2026-10-19T12:00"
        initialEnd="2026-10-19T11:00"
      />
    </SocialPlannerContext.Provider>,
  );
  await user.type(
    await screen.findByRole("textbox", { name: eventText("ru", "title") }),
    "Sketch walk",
  );
  await user.type(
    screen.getByRole("textbox", { name: eventText("ru", "description") }),
    "Bring a pencil",
  );
  await user.click(
    screen.getByRole("button", { name: eventText("ru", "publish") }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    eventText("ru", "required"),
  );
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/action"))).toBe(
    false,
  );
});
