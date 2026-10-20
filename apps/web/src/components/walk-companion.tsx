"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Lightbulb,
  MessageCircle,
  MessageCircleOff,
} from "lucide-react";
import type { VoiceLocale } from "@/lib/voice-input";
import styles from "./walk-companion.module.css";

export type CompanionPhase =
  "idle" | "searching" | "routing" | "ready" | "empty" | "error";
export interface WalkCompanionProps {
  locale: VoiceLocale;
  phase: CompanionPhase;
  stopCount?: number;
  overBudgetMinutes?: number;
  suggestions?: string[];
  onSuggestion?(text: string): void;
}

const copy = {
  ru: {
    name: "Спутник прогулки",
    role: "Подсказки по вашему плану",
    collapse: "Свернуть помощника",
    expand: "Развернуть помощника",
    mute: "Скрыть комментарии помощника",
    unmute: "Показать комментарии помощника",
    muted: "Комментарии скрыты",
    idle: "Какое у вас настроение? Расскажите, что хочется увидеть, и сколько времени есть на прогулку.",
    searching:
      "Ищу места по вашему описанию. Пожелания помогают выбрать то, что вам интересно.",
    routing:
      "Соединяю остановки по порядку. Скоро весь путь появится на карте.",
    ready: (count: number) =>
      `План готов${count > 0 ? `: ${count} ${count === 1 ? "остановка" : count < 5 ? "остановки" : "остановок"}` : ""}. Можно открыть любую точку или убрать её из плана.`,
    over: (minutes: number) =>
      `Прогулка примерно на ${minutes} мин дольше пожелания. Можно оставить весь путь или убрать одну из остановок.`,
    empty:
      "Для этого запроса пока нет подходящего плана. Попробуйте назвать место, занятие или изменить явно заданные фильтры.",
    error:
      "План пока не удалось построить. Ваше пожелание можно сохранить и повторить поиск.",
    ideas: "Подсказать идею",
    choose: "Выберите идею — она появится в описании. Поиск запускаете вы.",
    suggestions: [
      "Сначала выпить кофе, потом погулять в парке около часа",
      "Посмотреть красивую архитектуру Астаны вечером",
      "Неспешно прогуляться вдоль реки и полюбоваться видами",
    ],
  },
  kk: {
    name: "Серуен серігі",
    role: "Жоспарыңызға арналған кеңестер",
    collapse: "Көмекшіні жию",
    expand: "Көмекшіні ашу",
    mute: "Көмекшінің пікірлерін жасыру",
    unmute: "Көмекшінің пікірлерін көрсету",
    muted: "Пікірлер жасырылды",
    idle: "Көңіл күйіңіз қандай? Не көргіңіз келетінін және серуенге қанша уақытыңыз бар екенін айтыңыз.",
    searching:
      "Сипаттамаңызға сай орындарды іздеп жатырмын. Тілектеріңіз қызықты жерлерді таңдауға көмектеседі.",
    routing:
      "Аялдамаларды ретімен қосып жатырмын. Жол жақында картада көрінеді.",
    ready: (count: number) =>
      `Жоспар дайын${count > 0 ? `: ${count} аялдама` : ""}. Кез келген нүктені ашуға немесе жоспардан алып тастауға болады.`,
    over: (minutes: number) =>
      `Серуен қалаған уақыттан шамамен ${minutes} минут ұзақ. Барлық жолды қалдыруға немесе бір аялдаманы алып тастауға болады.`,
    empty:
      "Бұл сұрауға сәйкес жоспар әзірге табылмады. Орынды, әрекетті атаңыз немесе өзіңіз қосқан сүзгілерді өзгертіңіз.",
    error:
      "Жоспар әзірге құрылмады. Тілегіңізді сақтап, іздеуді қайталауға болады.",
    ideas: "Идея ұсыну",
    choose:
      "Идеяны таңдаңыз — ол сипаттамаға қосылады. Іздеуді өзіңіз бастайсыз.",
    suggestions: [
      "Алдымен кофе ішіп, содан кейін саябақта бір сағаттай серуендеу",
      "Кешке Астананың әдемі сәулетін көру",
      "Өзен бойымен асықпай серуендеп, көріністерді тамашалау",
    ],
  },
  en: {
    name: "Walk companion",
    role: "Suggestions for your plan",
    collapse: "Collapse companion",
    expand: "Expand companion",
    mute: "Hide companion comments",
    unmute: "Show companion comments",
    muted: "Comments hidden",
    idle: "What are you in the mood for? Describe what you would like to see and how much time you have.",
    searching:
      "Looking for places that match your description. Your wishes help choose places you will enjoy.",
    routing:
      "Connecting the stops in order. The complete route will appear on the map soon.",
    ready: (count: number) =>
      `Your plan is ready${count > 0 ? `: ${count} ${count === 1 ? "stop" : "stops"}` : ""}. Open any stop or remove it from the plan.`,
    over: (minutes: number) =>
      `This walk is about ${minutes} min longer than requested. Keep the full route or remove a stop if you prefer.`,
    empty:
      "There is no suitable plan for this request yet. Try naming a place or activity, or adjusting filters you selected.",
    error:
      "The plan could not be built yet. Keep your wish and try searching again.",
    ideas: "Suggest an idea",
    choose:
      "Choose an idea to put it in the description. You decide when to search.",
    suggestions: [
      "First have coffee, then walk in a park for about an hour",
      "See Astana's beautiful architecture in the evening",
      "Take a gentle walk along the river and enjoy the views",
    ],
  },
} as const;

export function CompassCharacter({
  emotion,
}: {
  emotion: "idle" | "thinking" | "happy" | "concern";
}) {
  return (
    <svg
      className={styles.character}
      viewBox="0 0 88 88"
      fill="none"
      aria-hidden="true"
      data-emotion={emotion}
    >
      <path
        d="M25 65 18 77M63 65l7 12"
        stroke="#315d52"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <path
        className={styles.arm}
        d="M18 44 8 37M70 44l10-7"
        stroke="#315d52"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="m39 9 5-5 5 5"
        stroke="#d3a42d"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="44"
        cy="42"
        r="31"
        fill="#f7f6dd"
        stroke="#315d52"
        strokeWidth="4"
      />
      <circle cx="44" cy="42" r="24" fill="#d1eee0" />
      <path
        className={styles.needle}
        d="m44 15-6 14h12l-6-14Z"
        fill="#d4a52c"
      />
      <circle cx="28" cy="49" r="4" fill="#edb7a0" fillOpacity=".8" />
      <circle cx="60" cy="49" r="4" fill="#edb7a0" fillOpacity=".8" />
      {emotion === "happy" ? (
        <path
          d="M29 40q5-7 10 0m10 0q5-7 10 0"
          stroke="#244c40"
          strokeWidth="3"
          strokeLinecap="round"
        />
      ) : (
        <>
          <ellipse
            className={styles.eye}
            cx="34"
            cy="41"
            rx="2.7"
            ry="4"
            fill="#244c40"
          />
          <ellipse
            className={styles.eye}
            cx="54"
            cy="41"
            rx="2.7"
            ry="4"
            fill="#244c40"
          />
        </>
      )}
      {emotion === "concern" ? (
        <>
          <path
            d="m29 31 9 3m12 0 9-3"
            stroke="#315d52"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M38 55q6-6 12 0"
            stroke="#315d52"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </>
      ) : emotion === "thinking" ? (
        <path
          d="M40 53h8"
          stroke="#315d52"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M37 51q7 8 14 0"
          stroke="#315d52"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export default function WalkCompanion({
  locale,
  phase,
  stopCount = 0,
  overBudgetMinutes = 0,
  suggestions,
  onSuggestion,
}: WalkCompanionProps) {
  const text = copy[locale];
  const [collapsed, setCollapsed] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showIdeas, setShowIdeas] = useState(false);
  const isBusy = phase === "searching" || phase === "routing";
  const emotion = isBusy
    ? "thinking"
    : phase === "error" ||
        phase === "empty" ||
        (phase === "ready" && overBudgetMinutes > 0)
      ? "concern"
      : phase === "ready"
        ? "happy"
        : "idle";
  const message =
    phase === "ready"
      ? overBudgetMinutes > 0
        ? text.over(Math.ceil(overBudgetMinutes))
        : text.ready(stopCount)
      : text[phase];
  const ideas = (suggestions ?? text.suggestions)
    .filter((idea) => idea.trim())
    .slice(0, 3);

  return (
    <aside
      className={styles.companion}
      aria-label={text.name}
      data-phase={phase}
      data-muted={muted}
      data-collapsed={collapsed}
    >
      <div className={styles.heading}>
        <CompassCharacter emotion={emotion} />
        <div className={styles.identity}>
          <strong>{text.name}</strong>
          <small>{text.role}</small>
        </div>
        <button
          type="button"
          className={styles.icon}
          aria-label={collapsed ? text.expand : text.collapse}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? (
            <ChevronDown size={17} aria-hidden="true" />
          ) : (
            <ChevronUp size={17} aria-hidden="true" />
          )}
        </button>
      </div>
      {!collapsed && (
        <div className={styles.body}>
          <div className={styles.comment}>
            <p aria-live={muted ? "off" : "polite"} aria-atomic="true">
              {muted ? text.muted : message}
            </p>
            <button
              type="button"
              className={styles.icon}
              aria-label={muted ? text.unmute : text.mute}
              aria-pressed={muted}
              onClick={() => setMuted(!muted)}
            >
              {muted ? (
                <MessageCircleOff size={16} aria-hidden="true" />
              ) : (
                <MessageCircle size={16} aria-hidden="true" />
              )}
            </button>
          </div>
          {onSuggestion && ideas.length > 0 && !muted && (
            <>
              <button
                type="button"
                className={styles.ideaToggle}
                disabled={isBusy}
                aria-expanded={showIdeas}
                onClick={() => setShowIdeas(!showIdeas)}
              >
                <Lightbulb size={16} aria-hidden="true" />
                {text.ideas}
              </button>
              {showIdeas && (
                <div className={styles.ideas}>
                  <p>{text.choose}</p>
                  {ideas.map((idea, index) => (
                    <button
                      type="button"
                      key={`${index}:${idea}`}
                      disabled={isBusy}
                      onClick={() => {
                        onSuggestion(idea);
                        setShowIdeas(false);
                      }}
                    >
                      {idea}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
