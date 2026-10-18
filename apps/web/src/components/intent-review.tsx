"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { IntentResponse } from "@astana/api-client";
import { asApiError, type ApiError } from "@/lib/api";
import { duration } from "@/lib/format";
import { label, t, type Locale } from "@/lib/i18n";
import { interpretIntent, type IntentSelection } from "@/lib/intent";
import { intentText } from "@/lib/intent-copy";
import { ErrorNotice } from "./details";

export default function IntentReview({
  query,
  locale,
  onApply,
}: {
  query: string;
  locale: Locale;
  onApply: (selection: IntentSelection) => void;
}) {
  const key = `${locale}\0${query}`;
  const [analysis, setAnalysis] = useState<{
    key: string;
    result: IntentResponse;
  } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; value: ApiError } | null>(
    null,
  );
  const [checked, setChecked] = useState<string[]>([]);
  const [useTime, setUseTime] = useState(false);
  const [appliedKey, setAppliedKey] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
      // Cancellation must release loading even if the transport never settles.
      setLoadingKey(null);
    },
    [key],
  );
  const result = analysis?.key === key ? analysis.result : null;
  const loading = loadingKey === key;
  const text = (name: Parameters<typeof intentText>[1]) =>
    intentText(locale, name);
  async function analyze() {
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setLoadingKey(key);
    setError(null);
    setAnalysis(null);
    setAppliedKey(null);
    try {
      const response = await interpretIntent(query, locale, pending.signal);
      if (controller.current === pending && !pending.signal.aborted) {
        setAnalysis({ key, result: response });
        setChecked(response.constraints.map((entry) => entry.constraint.key));
        setUseTime(false);
      }
    } catch (cause) {
      if (controller.current === pending && !pending.signal.aborted)
        setError({ key, value: asApiError(cause) });
    } finally {
      // A stale completion must not clear a replacement request for the same key.
      if (controller.current === pending) {
        controller.current = null;
        setLoadingKey(null);
      }
    }
  }
  return (
    <section className="intent-review" aria-label={text("review")}>
      <button
        type="button"
        className="secondary"
        disabled={!query.trim() || query.length > 2000 || loading}
        onClick={() => void analyze()}
      >
        <Sparkles size={16} aria-hidden="true" />
        {text(loading ? "analyzing" : "analyze")}
      </button>
      <p className="field-hint">{text("hint")}</p>
      <ErrorNotice
        error={error?.key === key ? error.value : null}
        locale={locale}
      />
      {loading && <p role="status">{text("analyzing")}</p>}
      {result && (
        <div className="intent-suggestions">
          <h3>{text("review")}</h3>
          <span className="badge">
            {text(result.provider === "rules" ? "rules" : "model")}
            {result.provider !== "rules"
              ? ` · ${result.provider === "openai" ? "OpenAI" : "NVIDIA"}`
              : ""}
          </span>
          {result.available_seconds !== null && (
            <label className="intent-choice">
              <input
                type="checkbox"
                checked={useTime}
                onChange={(event) => setUseTime(event.target.checked)}
              />
              <span>
                {text("useTime")}: {duration(result.available_seconds, locale)}
                <small>«{result.time_evidence}»</small>
              </span>
            </label>
          )}
          {result.constraints.map(({ constraint, source_quote }) => (
            <label className="intent-choice" key={constraint.key}>
              <input
                type="checkbox"
                checked={checked.includes(constraint.key)}
                onChange={(event) =>
                  setChecked((previous) =>
                    event.target.checked
                      ? [...previous, constraint.key]
                      : previous.filter((item) => item !== constraint.key),
                  )
                }
              />
              <span>
                {label(locale, constraint.key)} ·{" "}
                {t(locale, constraint.strength)}
                <small>«{source_quote}»</small>
              </span>
            </label>
          ))}
          {result.anchor_text && (
            <div className="notice">
              <strong>
                {text("anchor")}: {result.anchor_text}
              </strong>
              <p>{text("anchorHint")}</p>
            </div>
          )}
          {result.categories.length > 0 && (
            <p className="small">
              {text("categories")}:{" "}
              {result.categories
                .map((category) => label(locale, category))
                .join(", ")}
              <br />
              {text("categoriesHint")}
            </p>
          )}
          {result.clarification_questions.length > 0 && (
            <div>
              <h4>{text("questions")}</h4>
              <ul>
                {result.clarification_questions.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ul>
            </div>
          )}
          {result.warnings.map((warning, index) => (
            <p className="small warning-text" key={index}>
              {warning}
            </p>
          ))}
          {!result.constraints.length && result.available_seconds === null ? (
            <p>{text("noSettings")}</p>
          ) : (
            <>
              <p className="field-hint">{text("preserved")}</p>
              <button
                type="button"
                className="secondary"
                disabled={!checked.length && !useTime}
                onClick={() => {
                  onApply({
                    constraints: result.constraints
                      .filter((entry) => checked.includes(entry.constraint.key))
                      .map((entry) => entry.constraint),
                    available_seconds: useTime
                      ? result.available_seconds
                      : null,
                  });
                  setAppliedKey(key);
                }}
              >
                {text("apply")}
              </button>
            </>
          )}
        </div>
      )}
      {appliedKey === key && <p role="status">{text("applied")}</p>}
    </section>
  );
}
