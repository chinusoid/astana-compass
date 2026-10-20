export type VoiceLocale = "ru" | "kk" | "en";
export type VoicePhase = "idle" | "starting" | "listening" | "processing";
export type VoiceError =
  | "permission"
  | "no-speech"
  | "network"
  | "unsupported-language"
  | "unavailable";

export interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

export interface RecognitionEngine {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognitionConstructor = new () => RecognitionEngine;

export function recognitionConstructor(
  source: unknown = typeof window === "undefined" ? undefined : window,
): RecognitionConstructor | null {
  if (!source || typeof source !== "object") return null;
  const browser = source as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  const engine = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  return typeof engine === "function" ? engine : null;
}

export function recognitionLanguage(locale: VoiceLocale): string {
  return { ru: "ru-RU", kk: "kk-KZ", en: "en-US" }[locale];
}

function errorCode(code: string): VoiceError {
  if (code === "not-allowed" || code === "service-not-allowed")
    return "permission";
  if (code === "no-speech") return "no-speech";
  if (code === "network") return "network";
  if (code === "language-not-supported") return "unsupported-language";
  return "unavailable";
}

export interface VoiceSession {
  start(): void;
  stop(): void;
  cancel(): void;
}

/** One explicit recording. Cancellation detaches callbacks before aborting the browser. */
export function createVoiceSession(
  Constructor: RecognitionConstructor,
  options: {
    locale: VoiceLocale;
    onPhase(phase: VoicePhase): void;
    onDraft(text: string): void;
    onTranscript(text: string): void;
    onError(error: VoiceError): void;
    onFinished(): void;
  },
): VoiceSession {
  const engine = new Constructor();
  engine.lang = recognitionLanguage(options.locale);
  engine.continuous = true;
  engine.interimResults = true;
  let active = false;
  let started = false;
  let stopping = false;
  let draft = "";
  let finalText = "";

  function detach() {
    engine.onstart = null;
    engine.onresult = null;
    engine.onerror = null;
    engine.onend = null;
  }

  function finish(error?: VoiceError) {
    if (!active) return;
    active = false;
    detach();
    options.onPhase("idle");
    if (error) options.onError(error);
    else {
      // An explicit stop accepts the displayed draft; a natural end uses only
      // final results, so an interrupted connection cannot submit a partial wish.
      const transcript = (stopping ? draft : finalText).trim();
      if (transcript) options.onTranscript(transcript);
      else options.onError("no-speech");
    }
    options.onFinished();
  }

  engine.onstart = () => {
    if (active && !stopping) options.onPhase("listening");
  };
  engine.onresult = (event) => {
    if (!active) return;
    const results = Array.from(event.results);
    draft = results
      .map((result) => result[0]?.transcript.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    finalText = results
      .filter((result) => result.isFinal)
      .map((result) => result[0]?.transcript.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    options.onDraft(draft);
  };
  engine.onerror = (event) => {
    if (!active) return;
    finish(errorCode(event.error));
    try {
      engine.abort();
    } catch {
      /* Already stopped by the browser. */
    }
  };
  engine.onend = () => finish();

  return {
    start() {
      if (started) return;
      started = true;
      active = true;
      options.onPhase("starting");
      try {
        engine.start();
      } catch {
        finish("unavailable");
      }
    },
    stop() {
      if (!active || stopping) return;
      stopping = true;
      options.onPhase("processing");
      try {
        engine.stop();
      } catch {
        finish("unavailable");
      }
    },
    cancel() {
      if (!active) return;
      active = false;
      detach();
      try {
        engine.abort();
      } catch {
        /* A closed engine needs no further cleanup. */
      }
      options.onPhase("idle");
      options.onFinished();
    },
  };
}
