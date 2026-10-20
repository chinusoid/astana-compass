import type { JourneyPlan } from "@astana/api-client";
import type { Locale } from "@/lib/i18n";

const copy = {
  ru: {
    title: "Как поняли пожелание",
    explicit: "Порядок из вашего описания",
    suggested: "Предложенный порядок",
    rules: "Разбор по правилам",
    unresolved: "Нужно уточнить",
  },
  kk: {
    title: "Тілегіңізді қалай түсіндік",
    explicit: "Сипаттамаңыздағы рет",
    suggested: "Ұсынылған рет",
    rules: "Ережелер бойынша талдау",
    unresolved: "Нақтылау қажет",
  },
  en: {
    title: "How we understood your wish",
    explicit: "Order from your description",
    suggested: "Suggested order",
    rules: "Rule-based analysis",
    unresolved: "Needs clarification",
  },
};

export default function ScenarioPlan({
  plan,
  locale,
}: {
  plan: JourneyPlan;
  locale: Locale;
}) {
  if (!plan.stages.length) return null;
  const text = copy[locale];
  return (
    <section
      className="notice"
      aria-label={text.title}
      data-testid="scenario-plan"
    >
      <strong>{text.title}</strong>
      <p className="small">
        {text[plan.order]} ·{" "}
        {plan.provider === "rules"
          ? text.rules
          : plan.provider === "openai"
            ? "OpenAI"
            : "NVIDIA"}
      </p>
      <ol>
        {plan.stages.map((stage, index) => (
          <li key={`${index}:${stage.source_quote}`}>
            {stage.source_quote}
            {stage.kind === "unresolved" && <small> — {text.unresolved}</small>}
          </li>
        ))}
      </ol>
      {plan.clarification_questions.map((question) => (
        <p className="small" key={question}>
          {question}
        </p>
      ))}
    </section>
  );
}
