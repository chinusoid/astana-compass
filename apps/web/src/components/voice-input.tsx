"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Mic, Square, X } from "lucide-react";
import {
  createVoiceSession,
  recognitionConstructor,
  type VoiceError,
  type VoiceLocale,
  type VoicePhase,
  type VoiceSession,
} from "@/lib/voice-input";
import styles from "./voice-input.module.css";

const copy = {
  ru: {
    start: "Рассказать голосом",
    stop: "Готово",
    cancel: "Отмена",
    starting: "Ожидаем доступ к микрофону…",
    listening: "Слушаю ваше пожелание…",
    processing: "Завершаем запись…",
    unsupported:
      "В этом браузере голосовой ввод недоступен. Напишите пожелание текстом.",
    privacy:
      "Звук распознаётся средствами браузера и может отправляться его сервису. Запись включается только по нажатию.",
    permission:
      "Доступ к микрофону не разрешён. Разрешите его в настройках сайта или введите текст.",
    "no-speech": "Речь не распознана. Попробуйте ещё раз или введите текст.",
    network:
      "Не удалось связаться с сервисом распознавания. Попробуйте ещё раз или введите текст.",
    "unsupported-language":
      "Сервис браузера не поддерживает выбранный язык. Можно ввести пожелание текстом.",
    unavailable:
      "Не удалось включить голосовой ввод. Можно ввести пожелание текстом.",
    draft: "Распознанный текст",
    hint: "Нажмите «Готово», чтобы добавить текст в пожелание.",
  },
  kk: {
    start: "Дауыспен айту",
    stop: "Дайын",
    cancel: "Бас тарту",
    starting: "Микрофонға рұқсат күтілуде…",
    listening: "Тілегіңізді тыңдап тұрмын…",
    processing: "Жазба аяқталуда…",
    unsupported:
      "Бұл браузерде дауыспен енгізу қолжетімсіз. Тілегіңізді мәтінмен жазыңыз.",
    privacy:
      "Дыбысты браузер таниды және өз қызметіне жіберуі мүмкін. Жазба тек батырманы басқанда басталады.",
    permission:
      "Микрофонға рұқсат берілмеді. Сайт баптауларында рұқсат беріңіз немесе мәтін жазыңыз.",
    "no-speech": "Сөйлеу танылмады. Қайталап көріңіз немесе мәтін жазыңыз.",
    network:
      "Сөйлеуді тану қызметімен байланыс орнамады. Қайталап көріңіз немесе мәтін жазыңыз.",
    "unsupported-language":
      "Браузер қызметі таңдалған тілді қолдамайды. Тілегіңізді мәтінмен енгізіңіз.",
    unavailable:
      "Дауыспен енгізу іске қосылмады. Тілегіңізді мәтінмен енгізіңіз.",
    draft: "Танылған мәтін",
    hint: "Мәтінді тілекке қосу үшін «Дайын» батырмасын басыңыз.",
  },
  en: {
    start: "Describe by voice",
    stop: "Done",
    cancel: "Cancel",
    starting: "Waiting for microphone access…",
    listening: "Listening to your wish…",
    processing: "Finishing recording…",
    unsupported:
      "Voice input is unavailable in this browser. Please type your wish.",
    privacy:
      "Your browser recognises audio and may send it to its speech service. Recording starts only when you press the button.",
    permission:
      "Microphone access was not allowed. Enable it in site settings or type your wish.",
    "no-speech":
      "No speech was recognised. Please try again or type your wish.",
    network:
      "The speech service could not be reached. Please try again or type your wish.",
    "unsupported-language":
      "The browser service does not support this language. You can type your wish.",
    unavailable: "Voice input could not start. You can type your wish.",
    draft: "Recognised text",
    hint: "Press Done to add this text to your wish.",
  },
} as const;

export interface VoiceInputProps {
  locale: VoiceLocale;
  onTranscript(text: string): void;
  disabled?: boolean;
}

// Browser support is a capability snapshot, not a second state to synchronise
// after every hydration. The server renders a neutral, disabled microphone.
const subscribeCapability = () => () => {};
const browserCapability = () => Boolean(recognitionConstructor());
const serverCapability = () => null;

export default function VoiceInput({
  locale,
  onTranscript,
  disabled = false,
}: VoiceInputProps) {
  const text = copy[locale];
  const descriptionId = useId();
  const supported = useSyncExternalStore<boolean | null>(
    subscribeCapability,
    browserCapability,
    serverCapability,
  );
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [draft, setDraft] = useState("");
  const session = useRef<VoiceSession | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    return () => {
      session.current?.cancel();
      session.current = null;
    };
  }, []);
  useEffect(() => {
    session.current?.cancel();
    session.current = null;
  }, [disabled, locale]);

  const recording = phase !== "idle";

  function start() {
    if (disabled || session.current) return;
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      setError("unavailable");
      return;
    }
    setError(null);
    setDraft("");
    try {
      const nextSession = createVoiceSession(Constructor, {
        locale,
        onPhase: setPhase,
        onDraft: setDraft,
        onTranscript: (value) => onTranscriptRef.current(value),
        onError: setError,
        onFinished: () => {
          session.current = null;
          setDraft("");
        },
      });
      session.current = nextSession;
      nextSession.start();
    } catch {
      setError("unavailable");
      setPhase("idle");
      session.current = null;
    }
  }

  return (
    <div className={styles.voice} data-recording={recording}>
      <div className={styles.actions}>
        {recording ? (
          <>
            <button
              type="button"
              className={styles.record}
              disabled={phase === "processing" || disabled}
              onClick={() => session.current?.stop()}
            >
              <Square size={15} aria-hidden="true" /> {text.stop}
            </button>
            <button
              type="button"
              className={styles.cancel}
              onClick={() => session.current?.cancel()}
            >
              <X size={15} aria-hidden="true" /> {text.cancel}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.record}
            onClick={start}
            disabled={disabled || supported !== true}
            aria-describedby={descriptionId}
          >
            <Mic size={17} aria-hidden="true" /> {text.start}
          </button>
        )}
        {recording && (
          <span className={styles.indicator} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
      <p id={descriptionId} className={styles.hint}>
        {supported === false ? text.unsupported : text.privacy}
      </p>
      {recording && (
        <p className={styles.status} role="status">
          {text[phase as Exclude<VoicePhase, "idle">]}
        </p>
      )}
      {draft && (
        <div className={styles.draft} aria-label={text.draft}>
          <p>{draft}</p>
          <small>{text.hint}</small>
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {text[error]}
        </p>
      )}
    </div>
  );
}
