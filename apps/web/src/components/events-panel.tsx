"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  CommunityEvent,
  SocialActionRequest,
  SocialProfile,
} from "@astana/api-client";
import { astanaInstant, dateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { eventText } from "@/lib/events-copy";
import { loadCommunityEvents } from "@/lib/events-api";
import { createSocialApi, SocialApiError } from "@/lib/social-api";
import { useSharedPlanner } from "@/lib/shared-planner";
import { valid } from "@/lib/contracts";

export default function EventsPanel({
  initialStart,
  initialEnd,
}: {
  initialStart: string;
  initialEnd: string;
}) {
  const { locale, allowFixtures, origin, setCommunityEvents } =
    useSharedPlanner();
  const api = useMemo(() => createSocialApi(allowFixtures), [allowFixtures]);
  const [events, setEvents] = useState<CommunityEvent[]>([]);
  const [profile, setProfile] = useState<SocialProfile | null>(null);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"required" | "failed" | "expired" | null>(
    null,
  );
  const [success, setSuccess] = useState<"published" | "deleted" | null>(null);
  const [form, setForm] = useState({
    title: "",
    description: "",
    start: initialStart,
    end: initialEnd,
  });
  const controllers = useRef<Record<string, AbortController>>({});
  const mutationVersion = useRef(0);
  const text = (key: Parameters<typeof eventText>[1]) => eventText(locale, key);
  const refresh = useCallback(async () => {
    controllers.current.events?.abort();
    const controller = new AbortController();
    controllers.current.events = controller;
    setLoading(true);
    try {
      const data = await loadCommunityEvents(controller.signal);
      if (!controller.signal.aborted) {
        setEvents(data.events);
        setCommunityEvents(data.events);
        setError((previous) => (previous === "failed" ? null : previous));
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof SocialApiError && cause.code === "session_required"
            ? "expired"
            : "failed",
        );
        setCommunityEvents([]);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [setCommunityEvents]);
  useEffect(() => {
    const pending = controllers.current;
    const session = new AbortController();
    pending.session = session;
    const checkVersion = mutationVersion.current;
    // Fetch live data on page entry. Navigation aborts requests and clears map markers.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    void api
      .state(session.signal)
      .then((state) => {
        if (!session.signal.aborted && checkVersion === mutationVersion.current)
          setProfile(state?.profile ?? null);
      })
      .catch((cause) => {
        if (
          !session.signal.aborted &&
          !(
            cause instanceof SocialApiError && cause.code === "session_required"
          )
        )
          setError("failed");
      })
      .finally(() => {
        if (!session.signal.aborted) setChecking(false);
      });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15000);
    return () => {
      Object.values(pending).forEach((controller) => controller.abort());
      clearInterval(timer);
      setCommunityEvents([]);
    };
  }, [api, refresh, setCommunityEvents]);
  async function mutate(body: SocialActionRequest) {
    if (busy) return;
    controllers.current.action?.abort();
    const controller = new AbortController();
    controllers.current.action = controller;
    mutationVersion.current++;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const state = await api.action(body, controller.signal);
      if (!controller.signal.aborted) {
        setProfile(state?.profile ?? null);
        if (body.action === "event_create")
          setForm((previous) => ({ ...previous, title: "", description: "" }));
        setSuccess(body.action === "event_create" ? "published" : "deleted");
        await refresh();
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const expired =
          cause instanceof SocialApiError && cause.code === "session_required";
        if (expired) setProfile(null);
        setError(
          expired
            ? "expired"
            : cause instanceof SocialApiError && cause.code === "invalid"
              ? "required"
              : "failed",
        );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function publish() {
    try {
      if (!origin || !form.title.trim() || !form.description.trim())
        throw new Error("incomplete");
      const body: SocialActionRequest = {
        action: "event_create",
        title: form.title.trim(),
        description: form.description.trim(),
        location: origin,
        starts_at: astanaInstant(form.start),
        ends_at: astanaInstant(form.end),
      };
      if (
        !valid("SocialActionRequest", body) ||
        new Date(body.starts_at).getTime() >= new Date(body.ends_at).getTime()
      )
        throw new Error("invalid date");
      void mutate(body);
    } catch {
      setError("required");
    }
  }
  return (
    <section className="events-panel" aria-label={t(locale, "events")}>
      <p>{text("intro")}</p>
      {error && (
        <p className="notice amber" role="alert">
          {text(error)}
        </p>
      )}
      {success && (
        <p className="notice" role="status">
          {text(success)}
        </p>
      )}
      {checking ? (
        <p role="status">{text("checking")}</p>
      ) : !profile ? (
        <div className="notice">
          <p>{text("signIn")}</p>
          <Link href="/party" className="secondary" scroll={false}>
            {text("openParty")}
          </Link>
        </div>
      ) : (
        <details className="event-create" open>
          <summary>{text("newEvent")}</summary>
          <form
            className="event-form"
            onSubmit={(event) => {
              event.preventDefault();
              publish();
            }}
          >
            <label className="field">
              <span>{text("title")}</span>
              <input
                name="event-title"
                disabled={busy}
                required
                maxLength={100}
                value={form.title}
                onChange={(event) =>
                  setForm({ ...form, title: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{text("description")}</span>
              <textarea
                name="event-description"
                disabled={busy}
                required
                maxLength={1000}
                rows={3}
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{text("start")}</span>
              <input
                name="event-start"
                disabled={busy}
                type="datetime-local"
                required
                value={form.start}
                onChange={(event) =>
                  setForm({ ...form, start: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{text("end")}</span>
              <input
                name="event-end"
                disabled={busy}
                type="datetime-local"
                required
                value={form.end}
                onChange={(event) =>
                  setForm({ ...form, end: event.target.value })
                }
              />
            </label>
            <p className="field-hint">
              {origin
                ? `${text("point")}: ${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)}`
                : text("noPoint")}
            </p>
            <p className="small">{text("public")}</p>
            <button
              className="primary"
              type="submit"
              disabled={busy || !origin}
            >
              {busy ? t(locale, "loading") : text("publish")}
            </button>
          </form>
        </details>
      )}
      <button
        type="button"
        className="secondary"
        disabled={loading || busy}
        onClick={() => void refresh()}
      >
        {text("refresh")}
      </button>
      {loading && <p role="status">{t(locale, "loading")}</p>}
      {!loading && !events.length && !error && <p>{text("empty")}</p>}
      <div className="community-events">
        {events.map((event) => (
          <article className="community-event" key={event.id}>
            <span className="badge">{text("unverified")}</span>
            <h2>{event.title}</h2>
            <p>{event.description}</p>
            <p>
              {dateTime(event.starts_at, locale)} —{" "}
              {dateTime(event.ends_at, locale)} · Asia/Almaty
            </p>
            <p className="small">
              {text("author")}: {event.author.name}
              <br />
              {text("publishedAt")}: {dateTime(event.created_at, locale)}
              <br />
              {event.location.lat.toFixed(5)}, {event.location.lon.toFixed(5)}
            </p>
            {profile?.id === event.author.id && (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  void mutate({ action: "event_delete", event_id: event.id })
                }
              >
                {text("delete")}
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
