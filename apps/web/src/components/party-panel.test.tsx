import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SocialState } from "@astana/api-client";
import PartyPanel from "./party-panel";
import { socialStateFixture as initial } from "@/test/social-state";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  action: vi.fn(),
  session: vi.fn(),
  photo: vi.fn(),
  itinerary: vi.fn(),
  locations: vi.fn(),
  current: () => null,
}));
vi.mock("@/lib/shared-planner", () => ({
  useSharedPlanner: () => ({
    locale: "ru",
    allowFixtures: true,
    setSharedItinerary: mocks.itinerary,
    setSharedLocations: mocks.locations,
    currentRequest: mocks.current,
    query: "",
    setQuery: vi.fn(),
    origin: null,
    selectedPlaceIds: [],
  }),
}));
vi.mock("@/lib/social-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/social-api")>()),
  createSocialApi: () => ({
    state: mocks.state,
    action: mocks.action,
    session: mocks.session,
  }),
  encodeSharedPhoto: mocks.photo,
}));
let receiveLocation: PositionCallback | undefined;
let locate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mocks.state.mockResolvedValue(initial());
  mocks.action.mockResolvedValue(initial());
  mocks.photo.mockResolvedValue("data:image/jpeg;base64,/9j/2Q==");
  locate = vi.fn((success: PositionCallback) => {
    receiveLocation = success;
  });
  vi.stubGlobal(
    "navigator",
    Object.assign(Object.create(navigator), {
      geolocation: { getCurrentPosition: locate },
    }),
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  receiveLocation = undefined;
});
const shareName = "Поделиться точкой на 15 минут";
async function ready() {
  const rendered = render(<PartyPanel />);
  await screen.findByRole("button", { name: shareName });
  return rendered;
}
const position = {
  coords: { latitude: 51.1283, longitude: 71.4305 },
} as GeolocationPosition;
it("asks for location only after an explicit share action", async () => {
  await ready();
  expect(locate).not.toHaveBeenCalled();
  expect(mocks.action).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: shareName }));
  expect(locate).toHaveBeenCalledOnce();
  expect(mocks.action).not.toHaveBeenCalled();
  receiveLocation?.(position);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      {
        action: "location",
        party_id: "party",
        coordinates: { lat: 51.1283, lon: 71.4305 },
      },
      expect.any(AbortSignal),
    ),
  );
});
it("does not send a late position after the permission request is cancelled", async () => {
  await ready();
  await userEvent.click(screen.getByRole("button", { name: shareName }));
  await userEvent.click(
    screen.getByRole("button", { name: "Отменить запрос геолокации" }),
  );
  receiveLocation?.(position);
  expect(mocks.action).not.toHaveBeenCalled();
});
it("does not send a late position after leaving the group page", async () => {
  const rendered = await ready();
  await userEvent.click(screen.getByRole("button", { name: shareName }));
  rendered.unmount();
  receiveLocation?.(position);
  expect(mocks.action).not.toHaveBeenCalled();
});
it.each(["Прикрепить фото", "Снять фото"])(
  "previews %s without uploading until Send is pressed",
  async (label) => {
    await ready();
    const file = new File(["synthetic-image"], "image.jpg", {
      type: "image/jpeg",
    });
    if (label === "Снять фото")
      expect(screen.getByLabelText(label)).toHaveAttribute(
        "capture",
        "environment",
      );
    else expect(screen.getByLabelText(label)).not.toHaveAttribute("capture");
    fireEvent.change(screen.getByLabelText(label), {
      target: { files: [file] },
    });
    await screen.findByAltText("Предпросмотр фото перед отправкой");
    expect(mocks.photo).toHaveBeenCalledWith(file);
    expect(mocks.action).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(mocks.action).toHaveBeenCalledWith(
        {
          action: "message",
          party_id: "party",
          text: "",
          photo: "data:image/jpeg;base64,/9j/2Q==",
        },
        expect.any(AbortSignal),
      ),
    );
  },
);
it("keeps a new draft typed while the previous message is sending", async () => {
  let finish: (value: SocialState) => void = () => {};
  mocks.action.mockReturnValue(
    new Promise<SocialState>((resolve) => {
      finish = resolve;
    }),
  );
  await ready();
  const input = screen.getByLabelText("Сообщение");
  fireEvent.change(input, { target: { value: "First message" } });
  await userEvent.click(screen.getByRole("button", { name: "Отправить" }));
  fireEvent.change(input, { target: { value: "New draft" } });
  finish(initial());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Отправить" })).toBeEnabled(),
  );
  expect(input).toHaveValue("New draft");
});
