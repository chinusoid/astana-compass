import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RecognitionEngine } from "@/lib/voice-input";
import VoiceInput from "./voice-input";

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

afterEach(() => vi.unstubAllGlobals());

it("offers typed input when recognition is unsupported", () => {
  vi.stubGlobal("SpeechRecognition", undefined);
  vi.stubGlobal("webkitSpeechRecognition", undefined);
  render(<VoiceInput locale="ru" onTranscript={vi.fn()} />);
  expect(
    screen.getByRole("button", { name: "Рассказать голосом" }),
  ).toBeDisabled();
  expect(
    screen.getByText(/В этом браузере голосовой ввод недоступен/),
  ).toBeVisible();
});

it("starts only by explicit click and sends the recognised text after Done", async () => {
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  const callback = vi.fn();
  render(<VoiceInput locale="ru" onTranscript={callback} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Рассказать голосом" }),
  );
  const engine = FakeRecognition.latest;
  expect(engine.lang).toBe("ru-RU");
  expect(screen.getByRole("status")).toHaveTextContent("Слушаю ваше пожелание");
  act(() =>
    engine.onresult?.({
      results: [
        { 0: { transcript: "кофе и парк" }, isFinal: false, length: 1 },
      ],
    }),
  );
  expect(screen.getByLabelText("Распознанный текст")).toHaveTextContent(
    "кофе и парк",
  );
  await userEvent.click(screen.getByRole("button", { name: "Готово" }));
  expect(callback).not.toHaveBeenCalled();
  act(() => engine.onend?.());
  expect(callback).toHaveBeenCalledExactlyOnceWith("кофе и парк");
  expect(
    screen.getByRole("button", { name: "Рассказать голосом" }),
  ).toBeEnabled();
});

it("Cancel discards the recording, including a late browser result", async () => {
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  const callback = vi.fn();
  render(<VoiceInput locale="en" onTranscript={callback} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Describe by voice" }),
  );
  const engine = FakeRecognition.latest;
  const lateResult = engine.onresult;
  const lateEnd = engine.onend;
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  act(() => {
    lateResult?.({
      results: [
        { 0: { transcript: "discard this" }, isFinal: true, length: 1 },
      ],
    });
    lateEnd?.();
  });
  expect(callback).not.toHaveBeenCalled();
  expect(engine.abort).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("cancels before a different locale or disabled search can receive stale audio", async () => {
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
  const callback = vi.fn();
  const { rerender } = render(
    <VoiceInput locale="kk" onTranscript={callback} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Дауыспен айту" }));
  const engine = FakeRecognition.latest;
  expect(engine.lang).toBe("kk-KZ");
  rerender(<VoiceInput locale="en" disabled onTranscript={callback} />);
  expect(engine.abort).toHaveBeenCalledTimes(1);
  expect(engine.onresult).toBeNull();
  expect(
    screen.getByRole("button", { name: "Describe by voice" }),
  ).toBeDisabled();
  expect(callback).not.toHaveBeenCalled();
});

it("explains microphone permission failure and permits a retry", async () => {
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  render(<VoiceInput locale="ru" onTranscript={vi.fn()} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Рассказать голосом" }),
  );
  act(() => FakeRecognition.latest.onerror?.({ error: "not-allowed" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Доступ к микрофону не разрешён",
  );
  expect(
    screen.getByRole("button", { name: "Рассказать голосом" }),
  ).toBeEnabled();
});

it("unmount aborts the active microphone and detaches all events", async () => {
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  const { unmount } = render(<VoiceInput locale="en" onTranscript={vi.fn()} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Describe by voice" }),
  );
  const engine = FakeRecognition.latest;
  unmount();
  expect(engine.abort).toHaveBeenCalledTimes(1);
  expect(engine.onend).toBeNull();
  expect(engine.onresult).toBeNull();
});
