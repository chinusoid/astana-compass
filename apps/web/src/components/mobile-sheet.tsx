"use client";

import Link from "next/link";
import { ChevronDown, Maximize2, Search } from "lucide-react";
import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Locale } from "@/lib/i18n";
import styles from "./mobile-sheet.module.css";
import { ideasCopy } from "./route-ideas";
import {
  SHEET_SETTLED_EVENT,
  sheetDragOffset,
  sheetSnapIndex,
} from "@/lib/sheet-gesture";

export type SheetSnap = "collapsed" | "half" | "expanded";
const snaps: SheetSnap[] = ["collapsed", "half", "expanded"];
const query = "(max-width: 760px)";
function subscribe(update: () => void) {
  const media = window.matchMedia?.(query);
  media?.addEventListener?.("change", update);
  return () => media?.removeEventListener?.("change", update);
}
export function useMobileViewport() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
}
const copy = {
  ru: {
    search: "Куда пойдём?",
    open: "Открыть планирование",
    map: "К карте",
    expand: "Развернуть панель",
    handle: "Размер панели",
    collapsed: "Свёрнута",
    half: "Половина экрана",
    expanded: "Развёрнута",
    hint: "Потяните вверх или вниз. Стрелки меняют размер, Home открывает карту, End раскрывает панель.",
    ready: "Астана — в вашем темпе",
  },
  kk: {
    search: "Қайда барамыз?",
    open: "Жоспарлауды ашу",
    map: "Картаға",
    expand: "Панельді кеңейту",
    handle: "Панель өлшемі",
    collapsed: "Жиырылған",
    half: "Жарты экран",
    expanded: "Кеңейтілген",
    hint: "Жоғары не төмен тартыңыз. Бағыт пернелері өлшемді өзгертеді, Home картаны, End панельді ашады.",
    ready: "Астана — өз қарқыныңызбен",
  },
  en: {
    search: "Where shall we go?",
    open: "Open planner",
    map: "Show map",
    expand: "Expand panel",
    handle: "Panel size",
    collapsed: "Collapsed",
    half: "Half screen",
    expanded: "Expanded",
    hint: "Drag up or down. Arrow keys resize, Home shows the map, End expands the panel.",
    ready: "Astana, at your pace",
  },
};

export default function MobileSheet({
  snap,
  onSnap,
  onOpen,
  locale,
  wish,
  summary,
  ideasCount = 0,
  onOpenIdeas,
  plannerHref = "/walk",
}: {
  snap: SheetSnap;
  onSnap: (snap: SheetSnap) => void;
  onOpen: () => void;
  locale: Locale;
  wish: string;
  summary: string;
  ideasCount?: number;
  onOpenIdeas?: () => void;
  plannerHref?: string;
}) {
  const text = copy[locale];
  const drag = useRef<{
    pointer: number;
    panel: HTMLElement;
    y: number;
    height: number;
    heights: number[];
    offset: number;
    moved: boolean;
    samples: { y: number; time: number }[];
    release: () => void;
  } | null>(null);
  const preview = useRef<((notify?: boolean) => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => preview.current?.(false), []);
  function step(direction: number) {
    preview.current?.(false);
    onSnap(snaps[Math.max(0, Math.min(2, snaps.indexOf(snap) + direction))]);
  }
  function finish(event: PointerEvent, cancel = false) {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    drag.current = null;
    start.release();
    const delta = event.clientY - start.y;
    start.moved ||= !cancel && Math.abs(delta) > 8;
    suppressClick.current = !cancel;
    if (!start.moved) {
      preview.current?.(false);
      // Capturing on the stable ancestor can retarget the compatibility click.
      // Complete taps here; keyboard clicks still use the button's onClick.
      if (!cancel) step(snap === "expanded" ? -2 : 1);
      return;
    }
    const now = performance.now();
    const recent = start.samples.find((point) => now - point.time <= 90);
    const velocity = recent
      ? (event.clientY - recent.y) / Math.max(16, now - recent.time)
      : 0;
    const index = cancel
      ? snaps.indexOf(snap)
      : sheetSnapIndex(start.heights, start.height, delta, velocity);
    const target = start.heights[2] - start.heights[index];
    start.panel.removeAttribute("data-sheet-dragging");
    start.panel.style.setProperty("--sheet-drag", `${target}px`);
    if (!cancel) onSnap(snaps[index]);
    const duration = window.matchMedia?.("(prefers-reduced-motion: reduce)")
      .matches
      ? 0
      : 180;
    const animation = duration
      ? start.panel.animate?.(
          [
            { transform: `translate3d(0, ${start.offset}px, 0)` },
            { transform: `translate3d(0, ${target}px, 0)` },
          ],
          { duration, easing: "cubic-bezier(.2,.8,.2,1)" },
        )
      : undefined;
    const cleanup = preview.current;
    const stop = (notify = true) => {
      window.clearTimeout(timer);
      if (animation) animation.onfinish = null;
      animation?.cancel();
      cleanup?.(notify);
    };
    const timer = window.setTimeout(() => stop(), duration + 20);
    preview.current = stop;
    if (animation) animation.onfinish = () => stop();
  }
  function move(event: PointerEvent) {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    const now = performance.now();
    const delta = event.clientY - start.y;
    start.moved ||= Math.abs(delta) > 8;
    start.samples = start.samples.filter((point) => now - point.time <= 90);
    start.samples.push({ y: event.clientY, time: now });
    start.offset = sheetDragOffset(
      start.heights[2] - start.height + delta,
      start.heights[2] - start.heights[0],
    );
    start.panel.style.setProperty("--sheet-drag", `${start.offset}px`);
  }
  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || event.isPrimary === false || drag.current) return;
    const panel = event.currentTarget.closest<HTMLElement>(
      "[data-mobile-sheet]",
    );
    if (!panel) return;
    const capture =
      panel.closest<HTMLElement>(".app-shell") ?? panel.parentElement;
    if (!capture) return;
    // This is a custom drag control: retain focus without allowing the browser's
    // native mouse drag/selection behavior to take over the pointer stream.
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
    // Cache geometry once. Pointer moves below only write a compositor transform.
    const viewport = window.visualViewport?.height || window.innerHeight;
    const nav = panel.parentElement
      ?.querySelector(".app-rail")
      ?.getBoundingClientRect();
    const fallbackMaximum =
      Number.parseFloat(getComputedStyle(panel).maxHeight) ||
      Math.max(132, viewport - (nav?.height || 66) - 12);
    const rect = panel.getBoundingClientRect();
    const visibleHeight = panel.hasAttribute("data-sheet-preview")
      ? (nav?.top || viewport - 66) - rect.top
      : rect.height;
    preview.current?.(false);
    suppressClick.current = false;
    const transition = panel.style.transition;
    panel.style.transition = "none";
    panel.setAttribute("data-sheet-preview", "true");
    panel.setAttribute("data-sheet-dragging", "true");
    // Resolve the expanded CSS size once, including safe areas and the keyboard.
    const maximum = panel.offsetHeight || fallbackMaximum;
    const heights = [
      Math.min(132, maximum),
      Math.min(maximum, Math.max(132, viewport * 0.54)),
      maximum,
    ];
    const height = visibleHeight
      ? Math.max(heights[0], Math.min(maximum, visibleHeight))
      : heights[snaps.indexOf(snap)];
    panel.style.setProperty("--sheet-drag", `${maximum - height}px`);
    const pointer = event.pointerId;
    const up = (entry: PointerEvent) => finish(entry);
    const cancel = (entry: PointerEvent) => finish(entry, true);
    const lost = (entry: PointerEvent) => {
      if (entry.target === capture) finish(entry, true);
    };
    let listening = true;
    const release = () => {
      if (!listening) return;
      listening = false;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("lostpointercapture", lost, true);
      if (capture.hasPointerCapture?.(pointer))
        capture.releasePointerCapture(pointer);
    };
    let active = true;
    preview.current = (notify = true) => {
      if (!active) return;
      active = false;
      drag.current = null;
      release();
      panel.removeAttribute("data-sheet-preview");
      panel.removeAttribute("data-sheet-dragging");
      panel.style.removeProperty("--sheet-drag");
      // Commit the target height without animating layout after the GPU settle.
      void panel.offsetHeight;
      panel.style.transition = transition;
      if (!transition) panel.style.removeProperty("transition");
      preview.current = null;
      if (notify && panel.isConnected)
        panel.dispatchEvent(new Event(SHEET_SETTLED_EVENT));
    };
    drag.current = {
      pointer: event.pointerId,
      panel,
      y: event.clientY,
      height,
      heights,
      offset: maximum - height,
      moved: false,
      samples: [{ y: event.clientY, time: performance.now() }],
      release,
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("lostpointercapture", lost, true);
    // The sheet/handle translates under the finger. Keep capture on its fixed
    // ancestor so WebKit does not have to retarget a moving capture element.
    try {
      capture.setPointerCapture?.(pointer);
    } catch {
      // The single document stream still handles input if capture is unavailable.
    }
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (["ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(event.key)) {
      event.preventDefault();
      preview.current?.(false);
      if (event.key === "Home" || event.key === "Escape") onSnap("collapsed");
      else if (event.key === "End") onSnap("expanded");
      else step(event.key === "ArrowUp" ? 1 : -1);
    }
  }
  return (
    <div className={styles.controls} data-testid="mobile-sheet-controls">
      <button
        type="button"
        className={styles.handle}
        data-sheet-handle
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        aria-label={`${text.handle}: ${text[snap]}`}
        aria-expanded={snap !== "collapsed"}
        aria-controls="mobile-sheet-content"
        aria-describedby="sheet-gesture-hint"
        onKeyDown={keyboard}
        onClick={(event) => {
          if (suppressClick.current && event.detail > 0) {
            suppressClick.current = false;
            return;
          }
          suppressClick.current = false;
          step(snap === "expanded" ? -2 : 1);
        }}
        onPointerDown={beginDrag}
      >
        <span aria-hidden="true" />
      </button>
      <span className="sr-only" id="sheet-gesture-hint">
        {text.hint}
      </span>
      <div className={styles.searchRow}>
        <Link
          href={plannerHref}
          scroll={false}
          className={styles.search}
          onClick={() => {
            preview.current?.(false);
            onOpen();
          }}
          aria-label={text.open}
        >
          <Search size={21} aria-hidden="true" />
          <span>{wish.trim() || text.search}</span>
        </Link>
        {snap !== "collapsed" && (
          <button
            type="button"
            className={styles.mapButton}
            onClick={() => {
              preview.current?.(false);
              onSnap("collapsed");
            }}
            aria-label={text.map}
          >
            <ChevronDown size={22} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className={styles.summary}>
        <span role="status">{summary || text.ready}</span>
        {ideasCount > 0 && onOpenIdeas && (
          <button
            type="button"
            className={styles.ideasAction}
            onClick={() => {
              preview.current?.(false);
              onOpenIdeas();
            }}
            aria-controls="route-ideas"
          >
            {ideasCopy[locale].title}: {ideasCount}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            preview.current?.(false);
            onSnap(snap === "half" ? "expanded" : "half");
          }}
          aria-label={text.expand}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
