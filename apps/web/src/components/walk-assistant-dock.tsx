"use client";
import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import type { ItineraryResponse } from "@astana/api-client";
import type { Locale } from "@/lib/i18n";
import WalkCompanion, {
  CompassCharacter,
  type WalkCompanionProps,
} from "./walk-companion";
import WalkPlanBrief from "./walk-plan-brief";
import styles from "./walk-assistant-dock.module.css";

export default function WalkAssistantDock({
  open,
  onOpenChange,
  itinerary,
  hasTimeTarget,
  onDetails,
  onRefine,
  ...companion
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  itinerary: ItineraryResponse | null;
  hasTimeTarget: boolean;
  onDetails: (id: string) => void;
  onRefine: (goal: "lessWalking" | "scenic" | "variety") => void;
} & WalkCompanionProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);
  const locale = companion.locale as Locale;
  const text = {
    ru: {
      open: "Открыть спутника и разбор прогулки",
      close: "Закрыть спутника",
      ready: "Разберём ваш маршрут?",
      idle: "Помогу с прогулкой",
      busy: "Обдумываю прогулку…",
    },
    kk: {
      open: "Серікті және серуен талдауын ашу",
      close: "Серікті жабу",
      ready: "Бағытты талдаймыз ба?",
      idle: "Серуенге көмектесемін",
      busy: "Серуенді ойластырып жатырмын…",
    },
    en: {
      open: "Open companion and walk insights",
      close: "Close companion",
      ready: "Explore your walk?",
      idle: "Let’s plan a walk",
      busy: "Thinking about your walk…",
    },
  }[locale];
  const busy = companion.phase === "searching" || companion.phase === "routing";
  const emotion = busy
    ? "thinking"
    : companion.phase === "error" ||
        companion.phase === "empty" ||
        (companion.overBudgetMinutes ?? 0) > 0
      ? "concern"
      : companion.phase === "ready"
        ? "happy"
        : "idle";
  function close() {
    onOpenChange(false);
    trigger.current?.focus();
  }
  return (
    <div className={styles.dock} data-testid="walk-assistant-dock">
      {open && (
        <section
          id={id}
          className={styles.panel}
          aria-label={text.open}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <button
            ref={closeButton}
            type="button"
            className={styles.close}
            onClick={close}
            aria-label={text.close}
          >
            <X size={19} aria-hidden="true" />
          </button>
          <WalkCompanion {...companion} />
          {itinerary && itinerary.stops.length > 0 && (
            <WalkPlanBrief
              itinerary={itinerary}
              locale={locale}
              hasTimeTarget={hasTimeTarget}
              onDetails={onDetails}
              onRefine={(goal) => {
                // The old brief disappears while the new plan is calculated.
                closeButton.current?.focus();
                onRefine(goal);
              }}
              disabled={busy}
            />
          )}
        </section>
      )}
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label={text.open}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => onOpenChange(!open)}
      >
        <CompassCharacter emotion={emotion} />
        <span>
          {busy ? text.busy : itinerary?.stops.length ? text.ready : text.idle}
        </span>
      </button>
    </div>
  );
}
