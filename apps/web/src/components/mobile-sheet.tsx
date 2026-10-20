"use client";

import Link from "next/link";
import { ChevronDown, Maximize2, Search } from "lucide-react";
import {
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { Locale } from "@/lib/i18n";
import styles from "./mobile-sheet.module.css";

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
}: {
  snap: SheetSnap;
  onSnap: (snap: SheetSnap) => void;
  onOpen: () => void;
  locale: Locale;
  wish: string;
  summary: string;
}) {
  const text = copy[locale];
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  function step(direction: number) {
    onSnap(snaps[Math.max(0, Math.min(2, snaps.indexOf(snap) + direction))]);
  }
  function finish(event: PointerEvent<HTMLButtonElement>, cancel = false) {
    const start = drag.current;
    drag.current = null;
    event.currentTarget
      .closest<HTMLElement>("[data-mobile-sheet]")
      ?.style.removeProperty("--sheet-drag");
    if (!start) return;
    suppressClick.current = start.moved;
    if (!cancel && Math.abs(event.clientY - start.y) > 35)
      step(event.clientY < start.y ? 1 : -1);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (["ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(event.key)) {
      event.preventDefault();
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
        aria-label={`${text.handle}: ${text[snap]}`}
        aria-expanded={snap !== "collapsed"}
        aria-controls="mobile-sheet-content"
        aria-describedby="sheet-gesture-hint"
        onKeyDown={keyboard}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          step(snap === "expanded" ? -2 : 1);
        }}
        onPointerDown={(event) => {
          suppressClick.current = false;
          drag.current = { y: event.clientY, moved: false };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const delta = event.clientY - drag.current.y;
          drag.current.moved ||= Math.abs(delta) > 8;
          event.currentTarget
            .closest<HTMLElement>("[data-mobile-sheet]")
            ?.style.setProperty(
              "--sheet-drag",
              `${Math.max(-70, Math.min(100, delta))}px`,
            );
        }}
        onPointerUp={(event) => finish(event)}
        onPointerCancel={(event) => finish(event, true)}
      >
        <span aria-hidden="true" />
      </button>
      <span className="sr-only" id="sheet-gesture-hint">
        {text.hint}
      </span>
      <div className={styles.searchRow}>
        <Link
          href="/walk"
          scroll={false}
          className={styles.search}
          onClick={onOpen}
          aria-label={text.open}
        >
          <Search size={21} aria-hidden="true" />
          <span>{wish.trim() || text.search}</span>
        </Link>
        {snap !== "collapsed" && (
          <button
            type="button"
            className={styles.mapButton}
            onClick={() => onSnap("collapsed")}
            aria-label={text.map}
          >
            <ChevronDown size={22} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className={styles.summary}>
        <span role="status">{summary || text.ready}</span>
        <button
          type="button"
          onClick={() => onSnap(snap === "half" ? "expanded" : "half")}
          aria-label={text.expand}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
