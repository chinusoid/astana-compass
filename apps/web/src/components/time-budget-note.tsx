import { duration } from "@/lib/format";
import type { Locale } from "@/lib/i18n";

export default function TimeBudgetNote({
  totalSeconds,
  budgetSeconds,
  locale,
}: {
  totalSeconds: number;
  budgetSeconds?: number;
  locale: Locale;
}) {
  if (!budgetSeconds || totalSeconds <= budgetSeconds) return null;
  const extra = duration(totalSeconds - budgetSeconds, locale);
  const budget = duration(budgetSeconds, locale);
  const text = {
    ru: `На ${extra} дольше выбранных ${budget}. Можно выбрать этот маршрут, если у вас есть больше времени.`,
    kk: `Таңдалған ${budget} уақыттан ${extra} ұзағырақ. Уақытыңыз көбірек болса, осы маршрутты таңдауға болады.`,
    en: `${extra} longer than your ${budget} target. You can choose this route if you have more time.`,
  }[locale];
  return (
    <p className="notice amber" data-testid="time-budget-note">
      {text}
    </p>
  );
}
