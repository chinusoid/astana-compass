import { describe, expect, it, vi } from "vitest";
import {
  createVoiceSession,
  recognitionConstructor,
  recognitionLanguage,
  type RecognitionEngine,
  type RecognitionResult,
} from "./voice-input";

class FakeRecognition implements RecognitionEngine {
  static latest: FakeRecognition;
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: RecognitionEngine["onstart"] = null;
  onresult: RecognitionEngine["onresult"] = null;
  onerror: RecognitionEngine["onerror"] = null;
  onend: RecognitionEngine["onend"] = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    FakeRecognition.latest = this;
  }
}

function result(transcript: string, isFinal = true): RecognitionResult {
  return { 0: { transcript }, length: 1, isFinal };
}

function setup() {
  const callbacks = {
    locale: "ru" as const,
    onPhase: vi.fn(),
    onDraft: vi.fn(),
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onFinished: vi.fn(),
  };
  const session = createVoiceSession(FakeRecognition, callbacks);
  return { session, engine: FakeRecognition.latest, callbacks };
}

describe("voice recording lifecycle", () => {
  it("feature-detects both browser implementations without starting the microphone", () => {
    expect(recognitionConstructor({})).toBeNull();
    expect(recognitionConstructor(undefined)).toBeNull();
    expect(recognitionConstructor({ SpeechRecognition: FakeRecognition })).toBe(
      FakeRecognition,
    );
    expect(
      recognitionConstructor({ webkitSpeechRecognition: FakeRecognition }),
    ).toBe(FakeRecognition);
    expect(recognitionLanguage("kk")).toBe("kk-KZ");
    expect(recognitionLanguage("ru")).toBe("ru-RU");
    expect(recognitionLanguage("en")).toBe("en-US");
    const { engine } = setup();
    expect(engine.start).not.toHaveBeenCalled();
  });

  it("replaces interim results and submits one final transcript once", () => {
    const { session, engine, callbacks } = setup();
    session.start();
    session.start();
    expect(engine.start).toHaveBeenCalledTimes(1);
    engine.onresult?.({ results: [result("Сначала кофе", false)] });
    engine.onresult?.({
      results: [result("Сначала кофе"), result("потом парк", false)],
    });
    engine.onresult?.({
      results: [result("Сначала кофе"), result("потом парк")],
    });
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    const end = engine.onend;
    end?.();
    end?.();
    expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      "Сначала кофе потом парк",
    );
    expect(callbacks.onFinished).toHaveBeenCalledTimes(1);
    expect(engine.onresult).toBeNull();
  });

  it("explicit Done accepts the visible draft after the browser finishes", () => {
    const { session, engine, callbacks } = setup();
    session.start();
    engine.onresult?.({ results: [result("  В парк на час  ", false)] });
    session.stop();
    session.stop();
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(callbacks.onPhase).toHaveBeenLastCalledWith("processing");
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    engine.onend?.();
    expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      "В парк на час",
    );
  });

  it("cancellation and captured late events never submit stale text", () => {
    const { session, engine, callbacks } = setup();
    session.start();
    engine.onresult?.({ results: [result("Старое пожелание")] });
    const lateResult = engine.onresult;
    const lateEnd = engine.onend;
    const lateError = engine.onerror;
    session.cancel();
    lateResult?.({ results: [result("не должно попасть в запрос")] });
    lateEnd?.();
    lateError?.({ error: "network" });
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onFinished).toHaveBeenCalledTimes(1);
    expect(engine.abort).toHaveBeenCalledTimes(1);
    expect(engine.onend).toBeNull();
  });

  it("a network interruption does not submit partial or final text", () => {
    const { session, engine, callbacks } = setup();
    session.start();
    engine.onresult?.({ results: [result("незаконченная мысль")] });
    engine.onerror?.({ error: "network" });
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith("network");
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    expect(engine.abort).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not-allowed", "permission"],
    ["service-not-allowed", "permission"],
    ["no-speech", "no-speech"],
    ["language-not-supported", "unsupported-language"],
    ["audio-capture", "unavailable"],
  ])(
    "reports %s without an endless listening state",
    (browserCode, expected) => {
      const { session, engine, callbacks } = setup();
      session.start();
      engine.onerror?.({ error: browserCode });
      expect(callbacks.onError).toHaveBeenCalledWith(expected);
      expect(callbacks.onPhase).toHaveBeenLastCalledWith("idle");
      expect(callbacks.onFinished).toHaveBeenCalledTimes(1);
    },
  );

  it("does not accept unfinished speech when recognition ends naturally", () => {
    const { session, engine, callbacks } = setup();
    session.start();
    engine.onresult?.({ results: [result("Возможно", false)] });
    engine.onend?.();
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith("no-speech");
  });
});
