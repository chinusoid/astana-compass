"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Building2, Coffee, Landmark, Theater, Trees } from "lucide-react";
import type { Place, PlacePhotoResponse } from "@astana/api-client";
import { fetchPlacePhoto, hasPhotoIdentity } from "@/lib/place-photo";
import { label, type Locale } from "@/lib/i18n";

const copy = {
  ru: {
    illustration: "Иллюстрация категории",
    photo: "Фото",
    source: "Оригинал и авторство",
  },
  kk: {
    illustration: "Санат иллюстрациясы",
    photo: "Фото",
    source: "Түпнұсқа мен авторлық",
  },
  en: {
    illustration: "Category illustration",
    photo: "Photo",
    source: "Original and attribution",
  },
};

type Props = { place: Place; locale: Locale; detailed?: boolean };

export default function PlacePhoto(props: Props) {
  const eligible = hasPhotoIdentity(props.place);
  const qid = props.place.facts.find(
    (fact) => fact.key === "osm:wikidata",
  )?.value;
  // A record can be replaced under the same ID. Revoked identity or renamed
  // records must not retain an earlier photograph/alt text while rerendering.
  const key = JSON.stringify([
    props.place.id,
    props.locale,
    props.place.name,
    eligible,
    qid,
  ]);
  return <PhotoCover key={key} {...props} eligible={eligible} />;
}

function PhotoCover({
  place,
  locale,
  detailed = false,
  eligible,
}: Props & { eligible: boolean }) {
  const frame = useRef<HTMLElement | null>(null);
  const gradient = useId();
  const [photo, setPhoto] = useState<PlacePhotoResponse["photo"]>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const category = place.categories[0];
  const kind = place.categories.includes("park")
    ? "park"
    : place.categories.some((value) => ["cafe", "restaurant"].includes(value))
      ? "cafe"
      : place.categories.includes("museum")
        ? "museum"
        : place.categories.some((value) =>
              ["theatre", "theater"].includes(value),
            )
          ? "theater"
          : "city";
  const Icon = {
    park: Trees,
    cafe: Coffee,
    museum: Landmark,
    theater: Theater,
    city: Building2,
  }[kind];
  const colors = {
    park: ["#d8eee3", "#81bba1", "#236349"],
    cafe: ["#fae8ce", "#d8ab77", "#88562f"],
    museum: ["#f4e3d9", "#ce9b87", "#864e3d"],
    theater: ["#e9e2f7", "#b39acb", "#634883"],
    city: ["#e0ecf5", "#8bb3ce", "#315b77"],
  }[kind];
  const text = copy[locale];
  const visiblePhoto = photo && !failed;

  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    let started = false;
    const load = () => {
      if (started || controller.signal.aborted) return;
      started = true;
      void fetchPlacePhoto(place.id, locale, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setPhoto(result.photo);
        })
        .catch(() => {
          // A source outage leaves the labelled illustration and all place actions usable.
        });
    };
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "function" && frame.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            load();
          }
        },
        { rootMargin: "160px" },
      );
      observer.observe(frame.current);
    } else load();
    return () => {
      controller.abort();
      observer?.disconnect();
    };
  }, [place.id, locale, eligible]);

  return (
    <figure
      ref={frame}
      className={`place-cover place-cover-${kind}${detailed ? " place-cover-detailed" : ""}${visiblePhoto && loaded ? " has-photo" : ""}`}
      data-testid="place-cover"
      style={{
        margin: 0,
        overflow: "hidden",
        borderRadius: 16,
        background: colors[0],
      }}
    >
      <div
        className="place-cover-scene"
        style={{
          position: "relative",
          height: detailed ? 240 : 150,
          overflow: "hidden",
        }}
      >
        <svg
          className="place-cover-illustration"
          viewBox="0 0 640 240"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
          style={{ width: "100%", height: "100%" }}
        >
          <defs>
            <linearGradient id={gradient} x2="1" y2="1">
              <stop stopColor={colors[0]} />
              <stop offset="1" stopColor={colors[1]} />
            </linearGradient>
          </defs>
          <rect width="640" height="240" fill={`url(#${gradient})`} />
          <circle cx="528" cy="54" r="35" fill="#fff" opacity=".45" />
          <path
            d="M0 190 Q130 112 310 180 T640 151 V240 H0Z"
            fill={colors[2]}
            opacity=".13"
          />
          <path
            d="M0 223 Q210 145 375 217 T640 180 V240 H0Z"
            fill={colors[2]}
            opacity=".19"
          />
          {kind === "park" ? (
            <g fill={colors[2]} opacity=".5">
              <rect x="112" y="130" width="8" height="69" rx="4" />
              <circle cx="116" cy="115" r="35" />
              <rect x="490" y="131" width="8" height="64" rx="4" />
              <circle cx="494" cy="113" r="28" />
            </g>
          ) : (
            <g fill={colors[2]} opacity=".35">
              <rect x="82" y="121" width="65" height="80" rx="7" />
              <rect x="157" y="148" width="42" height="53" rx="5" />
              <rect x="466" y="132" width="44" height="65" rx="5" />
              <rect x="520" y="104" width="54" height="93" rx="7" />
            </g>
          )}
          <path
            d="M242 240 Q290 183 323 183 Q351 184 398 240"
            fill="#fff"
            opacity=".28"
          />
        </svg>
        <div
          className="place-cover-symbol"
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            color: colors[2],
          }}
        >
          <Icon size={68} strokeWidth={1.25} />
        </div>
        {visiblePhoto && (
          // Commons already supplies a bounded thumbnail; keep its URL and attribution intact.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="place-cover-photo"
            src={photo.url}
            alt={photo.alt}
            width={800}
            height={450}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            aria-hidden={!loaded}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: loaded ? 1 : 0,
              transition: "opacity .25s ease",
            }}
          />
        )}
      </div>
      <figcaption
        className="place-cover-caption"
        style={{
          padding: "7px 12px",
          fontSize: 11,
          lineHeight: 1.5,
          color: "#364b40",
          background: "#ffffffc7",
        }}
      >
        {visiblePhoto && loaded ? (
          <>
            {text.photo}: {photo.author} ·{" "}
            <a
              href={photo.license_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {photo.license}
            </a>
            {" · "}
            <a
              href={photo.source_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${text.source}: ${place.name}`}
            >
              Wikimedia Commons
            </a>
          </>
        ) : (
          <>
            {text.illustration}
            {category ? ` · ${label(locale, category)}` : ""}
          </>
        )}
      </figcaption>
    </figure>
  );
}
