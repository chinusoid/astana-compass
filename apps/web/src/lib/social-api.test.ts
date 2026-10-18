import { afterEach, expect, it, vi } from "vitest";
import type { RecommendationResponse, SocialState } from "@astana/api-client";
import examples from "../../../../contracts.examples.json";
import {
  createSocialApi,
  encodeSharedPhoto,
  SocialApiError,
} from "./social-api";

const initial = (): SocialState => ({
  profile: { id: "person-one", name: "Synthetic guest" },
  friend_code: "synthetic-friend-code",
  friends: [],
  friend_requests: [],
  party_invites: [],
  expires_at: "2026-10-20T12:00:00+05:00",
  parties: [
    {
      id: "group-one",
      name: "Synthetic offline group",
      owner_id: "person-one",
      members: [
        {
          profile: { id: "person-one", name: "Synthetic guest" },
          available_seconds: 3600,
          constraints: [],
        },
      ],
      revision: 1,
      recommendations: null,
      itinerary: null,
      messages: [],
      locations: [],
    },
  ],
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses the same-origin cookie and accepts a canonical social state without bearer storage", async () => {
  const fetcher = vi.fn(async () => Response.json(initial()));
  vi.stubGlobal("fetch", fetcher);
  const state = await createSocialApi(false).state(
    new AbortController().signal,
  );
  expect(state?.profile.name).toBe("Synthetic guest");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/social/state",
    expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      headers: {},
    }),
  );
  expect(localStorage.length).toBe(0);
});
it("rejects a session response that exposes a backend token", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ token: "must-not-enter-the-client", state: initial() }),
    ),
  );
  await expect(
    createSocialApi(false).session("Guest", new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
});
it("turns a server error into fixed safe diagnostics", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: { code: "secret-debug-value" } }, { status: 401 }),
    ),
  );
  await expect(
    createSocialApi(false).state(new AbortController().signal),
  ).rejects.toEqual(new SocialApiError("session_required"));
});
it.each([
  "owner",
  "duplicate-party",
  "duplicate-friend",
  "outside-message",
  "duplicate-message",
])("rejects inconsistent social references: %s", async (kind) => {
  const state = initial();
  const message = {
    id: "message-one",
    author: state.profile,
    text: "Synthetic message",
    photo: null,
    created_at: "2026-10-19T12:00:00+05:00",
  };
  if (kind === "owner") state.parties[0].owner_id = "outsider";
  if (kind === "duplicate-party")
    state.parties.push(structuredClone(state.parties[0]));
  if (kind === "duplicate-friend")
    state.friends = [
      { id: "friend", name: "Friend" },
      { id: "friend", name: "Friend" },
    ];
  if (kind === "outside-message")
    state.parties[0].messages = [
      { ...message, author: { id: "outsider", name: "Outsider" } },
    ];
  if (kind === "duplicate-message")
    state.parties[0].messages = [message, structuredClone(message)];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(state)),
  );
  await expect(
    createSocialApi(true).state(new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
});
it("does not expose a synthetic shared plan without fixture opt-in", async () => {
  const state = initial();
  const sample = examples.cases.find(
    (item) =>
      item.valid &&
      item.definition === "RecommendationResponse" &&
      "recommendations" in item.instance &&
      (item.instance.recommendations as unknown[]).length > 0,
  )!;
  state.parties[0].recommendations = structuredClone(
    sample.instance,
  ) as RecommendationResponse;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(state, { headers: { "X-Astana-Data-Mode": "fixture" } }),
    ),
  );
  await expect(
    createSocialApi(false).state(new AbortController().signal),
  ).rejects.toMatchObject({ code: "fixture_disabled" });
  await expect(
    createSocialApi(true).state(new AbortController().signal),
  ).resolves.toMatchObject({ profile: state.profile });
});
it("rejects invalid actions before a request is sent", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(() =>
    createSocialApi(false).action(
      {
        action: "preferences",
        party_id: "group",
        available_seconds: 0,
        constraints: [],
      },
      new AbortController().signal,
    ),
  ).toThrow(SocialApiError);
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects SVG and oversized photos before image decoding", async () => {
  const decode = vi.fn();
  vi.stubGlobal("createImageBitmap", decode);
  await expect(
    encodeSharedPhoto(
      new File(["<svg/>"], "image.svg", { type: "image/svg+xml" }),
    ),
  ).rejects.toMatchObject({ code: "photo_type" });
  const large = new File(["jpeg"], "large.jpg", { type: "image/jpeg" });
  Object.defineProperty(large, "size", { value: 9 * 1024 * 1024 });
  await expect(encodeSharedPhoto(large)).rejects.toMatchObject({
    code: "photo_size",
  });
  expect(decode).not.toHaveBeenCalled();
});
it("re-encodes a fresh JPEG instead of sending original EXIF-bearing bytes", async () => {
  const bitmap = { width: 1200, height: 800, close: vi.fn() };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue("data:image/jpeg;base64,/9j/2Q==");
  const result = await encodeSharedPhoto(
    new File(["EXIF GPS PRIVATE SOURCE BYTES"], "source.jpg", {
      type: "image/jpeg",
    }),
  );
  expect(result).toBe("data:image/jpeg;base64,/9j/2Q==");
  expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 480, 320);
  expect(encode).toHaveBeenCalledWith("image/jpeg", 0.7);
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(result).not.toContain("PRIVATE");
});
it("reduces an encoded photo until it fits the complete data URI limit", async () => {
  const bitmap = { width: 1200, height: 800, close: vi.fn() };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValueOnce(`data:image/jpeg;base64,${"A".repeat(25000)}`)
    .mockReturnValue("data:image/jpeg;base64,/9j/2Q==");
  expect(
    await encodeSharedPhoto(
      new File(["jpeg"], "photo.jpg", { type: "image/jpeg" }),
    ),
  ).toHaveLength(31);
  expect(encode).toHaveBeenNthCalledWith(2, "image/jpeg", 0.5);
});
