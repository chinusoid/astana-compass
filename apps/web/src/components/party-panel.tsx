"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Check,
  Copy,
  Camera,
  ImagePlus,
  LocateFixed,
  LogOut,
  Send,
  Users,
  X,
} from "lucide-react";
import type {
  Constraint,
  PartyState,
  SocialActionRequest,
  SocialMember,
  SocialState,
} from "@astana/api-client";
import {
  createSocialApi,
  encodeSharedPhoto,
  SocialApiError,
  type SocialFailure,
} from "@/lib/social-api";
import { useSharedPlanner } from "@/lib/shared-planner";
import { dateTime, duration } from "@/lib/format";
import { label, t, type Locale } from "@/lib/i18n";
import { Sources, Warnings } from "./details";

const copy = {
  intro: [
    "Прогулка, которая подходит всем",
    "Барлығына қолайлы серуен",
    "A walk that works for everyone",
  ],
  privacy: [
    "Гостевой профиль до 24 часов. Компания, чат и маршрут хранятся в памяти сервера и исчезнут при перезапуске. Без пароля и постоянного аккаунта.",
    "Қонақ профилі 24 сағатқа дейін. Топ, чат және маршрут сервер жадында сақталады, қайта іске қосылғанда жойылады. Құпиясөз бен тұрақты аккаунт жоқ.",
    "Guest profile for up to 24 hours. Groups, chat and routes live in server memory and disappear on restart. No password or permanent account.",
  ],
  name: ["Как вас зовут?", "Атыңыз кім?", "Your name"],
  createProfile: [
    "Создать гостевой профиль",
    "Қонақ профилін құру",
    "Create guest profile",
  ],
  expires: ["Профиль действует до", "Профиль мерзімі", "Profile expires"],
  signOut: [
    "Выйти и удалить профиль",
    "Шығып, профильді жою",
    "Leave and delete profile",
  ],
  friendCode: [
    "Ваш код для друзей",
    "Достарға арналған кодыңыз",
    "Your friend code",
  ],
  copy: ["Скопировать код", "Кодты көшіру", "Copy code"],
  copied: ["Код скопирован", "Код көшірілді", "Code copied"],
  copyFailed: [
    "Выделите и скопируйте код вручную.",
    "Кодты таңдап, қолмен көшіріңіз.",
    "Select and copy the code manually.",
  ],
  friends: [
    "Друзья и приглашения",
    "Достар және шақырулар",
    "Friends and invitations",
  ],
  enterCode: ["Код друга", "Дос коды", "Friend’s code"],
  addFriend: ["Отправить запрос", "Сұрау жіберу", "Send request"],
  accept: ["Принять", "Қабылдау", "Accept"],
  remove: ["Удалить", "Жою", "Remove"],
  requestSent: [
    "Запрос отправлен. Друг должен принять его в своей сессии.",
    "Сұрау жіберілді. Досыңыз оны өз сессиясында қабылдауы керек.",
    "Request sent. Your friend needs to accept it in their session.",
  ],
  noFriends: [
    "Обменяйтесь кодами в отдельных браузерных сессиях.",
    "Бөлек браузер сессияларында кодтармен алмасыңыз.",
    "Exchange codes in separate browser sessions.",
  ],
  newParty: ["Новая компания", "Жаңа топ", "New group"],
  partyName: ["Название компании", "Топ атауы", "Group name"],
  createParty: ["Создать компанию", "Топ құру", "Create group"],
  chooseParty: ["Открыть компанию", "Топты ашу", "Open group"],
  leaveParty: ["Выйти из компании", "Топтан шығу", "Leave group"],
  invite: ["Пригласить друга", "Досты шақыру", "Invite a friend"],
  invited: [
    "Приглашение отправлено. Участник должен принять его.",
    "Шақыру жіберілді. Қатысушы оны қабылдауы керек.",
    "Invitation sent. The participant needs to accept it.",
  ],
  memberCount: [
    "участников · максимум 5",
    "қатысушы · ең көбі 5",
    "members · maximum 5",
  ],
  you: ["вы", "сіз", "you"],
  preferences: [
    "Моё время и условия",
    "Менің уақытым мен шарттарым",
    "My time and needs",
  ],
  minutes: [
    "Минут на всю прогулку",
    "Бүкіл серуенге минут",
    "Minutes for the whole walk",
  ],
  optional: ["Не учитывать", "Ескермеу", "Not specified"],
  saveNeeds: ["Сохранить мои условия", "Шарттарымды сақтау", "Save my needs"],
  groupHint: [
    "Берём самый короткий бюджет участников и все обязательные условия. Изменение условий сбрасывает прежний расчёт.",
    "Қатысушылардың ең қысқа уақытын және барлық міндетті шарттарын ескереміз. Шарттар өзгерсе, бұрынғы есеп жойылады.",
    "Uses the shortest member time budget and every required condition. Changing needs clears the previous calculation.",
  ],
  planSetup: [
    "Сначала задайте старт, пожелание и время в разделе «Прогулка».",
    "Алдымен «Серуен» бөлімінде бастау нүктесін, тілекті және уақытты таңдаңыз.",
    "First set your start, request and time on the Walk page.",
  ],
  goWalk: ["Настроить прогулку", "Серуенді баптау", "Set up the walk"],
  recommend: [
    "Найти варианты для всех",
    "Барлығына нұсқалар табу",
    "Find options for everyone",
  ],
  chooseStops: [
    "Выберите 1–3 остановки в порядке посещения",
    "Бару ретімен 1–3 аялдаманы таңдаңыз",
    "Choose 1–3 stops in visiting order",
  ],
  add: ["Добавить в общий план", "Ортақ жоспарға қосу", "Add to shared plan"],
  removeStop: ["Убрать из плана", "Жоспардан алып тастау", "Remove from plan"],
  build: [
    "Построить общий маршрут",
    "Ортақ маршрут құру",
    "Build shared route",
  ],
  sharedPlan: ["Общий план", "Ортақ жоспар", "Shared plan"],
  noMatch: [
    "Подходящего варианта пока нет. Проверьте ограничения каждого участника; они не ослаблены автоматически.",
    "Әзірге қолайлы нұсқа жоқ. Әр қатысушының шарттарын тексеріңіз; олар автоматты түрде жеңілдетілмейді.",
    "No suitable option yet. Check each member’s needs; no requirements were silently relaxed.",
  ],
  sharedSync: [
    "Обновляется каждые 3 секунды, пока вкладка видима",
    "Бет көрініп тұрғанда әр 3 секунд сайын жаңарады",
    "Refreshes every 3 seconds while the tab is visible",
  ],
  chat: ["Чат компании", "Топ чаты", "Group chat"],
  chatHint: [
    "Последние 50 сообщений, до 6 фото. Видны участникам компании; не отправляйте чувствительные данные.",
    "Соңғы 50 хабарлама, 6 фотоға дейін. Топ мүшелері көреді; құпия деректерді жібермеңіз.",
    "Latest 50 messages, up to 6 photos. Visible to group members; avoid sensitive information.",
  ],
  message: ["Сообщение", "Хабарлама", "Message"],
  send: ["Отправить", "Жіберу", "Send"],
  photo: ["Прикрепить фото", "Фото тіркеу", "Attach photo"],
  capture: ["Снять фото", "Фото түсіру", "Take a photo"],
  photoHint: [
    "JPEG, PNG или WebP до 8 МБ. Перед отправкой уменьшим и удалим метаданные; отправляется только после нажатия кнопки.",
    "8 МБ дейінгі JPEG, PNG немесе WebP. Жіберер алдында кішірейтіп, метадеректерді өшіреміз; тек батырмадан кейін жіберіледі.",
    "JPEG, PNG or WebP up to 8 MB. Resized and stripped of metadata before sending; uploaded only when you press Send.",
  ],
  removePhoto: ["Убрать фото", "Фотоны алып тастау", "Remove photo"],
  photoAlt: [
    "Фото участника компании",
    "Топ мүшесінің фотосы",
    "Photo shared by a group member",
  ],
  preview: [
    "Предпросмотр фото перед отправкой",
    "Жіберер алдындағы фото",
    "Photo preview before sending",
  ],
  emptyChat: [
    "Договоритесь о встрече здесь.",
    "Кездесуді осында келісіңіз.",
    "Arrange your meeting here.",
  ],
  location: [
    "Местоположение для компании",
    "Топқа арналған орналасу орны",
    "Location for the group",
  ],
  locationHint: [
    "По кнопке отправляется одна текущая точка на 15 минут. Только участникам этой компании; без фонового отслеживания. Остановка удаляет точку из группы, но не стирает уже увиденное другими.",
    "Батырма бір ағымдағы нүктені 15 минутқа жібереді. Тек осы топқа, фондық бақылаусыз. Тоқтату нүктені топтан жояды, бірақ өзгелер көргенін өшірмейді.",
    "The button shares one current position for 15 minutes with this group, without background tracking. Stopping removes it from the group but cannot erase what others already saw.",
  ],
  shareLocation: [
    "Поделиться точкой на 15 минут",
    "Нүктені 15 минутқа бөлісу",
    "Share position for 15 minutes",
  ],
  stopLocation: ["Перестать делиться", "Бөлісуді тоқтату", "Stop sharing"],
  cancelLocation: [
    "Отменить запрос геолокации",
    "Геолокация сұрауын болдырмау",
    "Cancel location request",
  ],
  locationUntil: [
    "Точка видна до",
    "Нүкте көрінетін уақыт",
    "Position visible until",
  ],
  geoError: [
    "Местоположение недоступно. Проверьте разрешение браузера; ничего не отправлено.",
    "Орналасу орны қолжетімсіз. Браузер рұқсатын тексеріңіз; ештеңе жіберілген жоқ.",
    "Location unavailable. Check browser permission; nothing was sent.",
  ],
  done: ["Готово", "Дайын", "Done"],
  loading: ["Загружаем компанию…", "Топ жүктелуде…", "Loading group…"],
  busy: ["Сохраняем изменения…", "Өзгерістер сақталуда…", "Saving changes…"],
  session_required: [
    "Гостевая сессия завершилась. Создайте профиль снова.",
    "Қонақ сессиясы аяқталды. Профильді қайта құрыңыз.",
    "Your guest session ended. Create a profile again.",
  ],
  conflict: [
    "Компания изменилась или достигла лимита. Данные обновлены — проверьте участников и повторите действие.",
    "Топ өзгерді немесе шекке жетті. Деректер жаңартылды — қатысушыларды тексеріп, қайталаңыз.",
    "The group changed or reached a limit. Data was refreshed; check the members and try again.",
  ],
  constraint_conflict: [
    "Условия участников противоречат друг другу. Согласуйте их вместе; мы не убираем обязательные условия.",
    "Қатысушылардың шарттары қайшы. Бірге келісіңіз; міндетті шарттарды алып тастамаймыз.",
    "Members’ needs conflict. Agree on them together; required conditions are never silently removed.",
  ],
  unavailable: [
    "Не удалось обновить данные. Проверьте соединение или приглашение и попробуйте ещё раз.",
    "Деректер жаңартылмады. Байланысты немесе шақыруды тексеріп, қайталаңыз.",
    "Could not update. Check the connection or invitation and try again.",
  ],
  rate_limited: [
    "Слишком много действий. Подождите немного и повторите.",
    "Әрекет тым көп. Біраз күтіп, қайталаңыз.",
    "Too many actions. Wait a moment and try again.",
  ],
  invalid: [
    "Не удалось проверить данные. Проверьте форму или обновите страницу.",
    "Деректер тексерілмеді. Пішінді тексеріңіз немесе бетті жаңартыңыз.",
    "Could not validate the data. Check the form or reload the page.",
  ],
  fixture_disabled: [
    "Этот общий план содержит демонстрационные места. В этом режиме их показ выключен.",
    "Ортақ жоспарда демонстрациялық орындар бар. Бұл режимде олар көрсетілмейді.",
    "This shared plan contains demonstration places, which are disabled in this mode.",
  ],
  photo_type: [
    "Не удалось открыть фото. Выберите JPEG, PNG или WebP.",
    "Фото ашылмады. JPEG, PNG немесе WebP таңдаңыз.",
    "Could not open the photo. Choose JPEG, PNG or WebP.",
  ],
  photo_size: [
    "Фото слишком большое. Выберите изображение до 8 МБ или уменьшите его.",
    "Фото тым үлкен. 8 МБ дейінгі сурет таңдаңыз немесе кішірейтіңіз.",
    "Photo is too large. Choose an image under 8 MB or reduce its size.",
  ],
} as const;
type CopyKey = keyof typeof copy;
const say = (locale: Locale, key: CopyKey) =>
  copy[key][locale === "ru" ? 0 : locale === "kk" ? 1 : 2];
const constraintKeys = [
  "indoor",
  "child_friendly",
  "wheelchair_accessible",
  "open_at_requested_time",
];
type Mutate = (
  action: SocialActionRequest,
  success?: CopyKey,
) => Promise<boolean>;

export default function PartyPanel() {
  const { locale, allowFixtures, setSharedItinerary, setSharedLocations } =
    useSharedPlanner();
  const api = useMemo(() => createSocialApi(allowFixtures), [allowFixtures]);
  const [state, setState] = useState<SocialState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SocialFailure | null>(null);
  const [notice, setNotice] = useState<CopyKey | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [partyName, setPartyName] = useState("");
  const [partyId, setPartyId] = useState("");
  const stateRef = useRef<SocialState | null>(null);
  const mounted = useRef(false);
  const changing = useRef(false);
  const epoch = useRef(0);
  const polling = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const applyState = useCallback((next: SocialState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const refresh = useCallback(
    async (force = false) => {
      if (
        !mounted.current ||
        document.hidden ||
        changing.current ||
        polling.current ||
        (!force && !stateRef.current)
      )
        return;
      const controller = new AbortController();
      polling.current = controller;
      const stamp = epoch.current;
      try {
        const next = await api.state(controller.signal);
        if (mounted.current && stamp === epoch.current) {
          applyState(next);
          setError((previous) =>
            previous === "unavailable" ? null : previous,
          );
        }
      } catch (cause) {
        if (
          !mounted.current ||
          controller.signal.aborted ||
          stamp !== epoch.current
        )
          return;
        if (
          cause instanceof SocialApiError &&
          cause.code === "session_required"
        ) {
          if (stateRef.current) setError("session_required");
          applyState(null);
        } else
          setError(
            cause instanceof SocialApiError ? cause.code : "unavailable",
          );
      } finally {
        if (polling.current === controller) polling.current = null;
        if (mounted.current) setLoaded(true);
      }
    },
    [api, applyState],
  );
  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => void refresh(true));
    const interval = window.setInterval(() => void refresh(), 3000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      // Invalidate pending requests across unmounts/Strict Mode, not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
      polling.current?.abort();
      polling.current = null;
      actionController.current?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const active =
    state?.parties.find((party) => party.id === partyId) ??
    state?.parties[0] ??
    null;
  useEffect(() => {
    setSharedItinerary(active?.itinerary ?? null);
    setSharedLocations(active?.locations ?? []);
  }, [active, setSharedItinerary, setSharedLocations]);
  useEffect(
    () => () => {
      setSharedItinerary(null);
      setSharedLocations([]);
    },
    [setSharedItinerary, setSharedLocations],
  );
  async function change(
    operation: (signal: AbortSignal) => Promise<SocialState | null>,
    success: CopyKey = "done",
  ) {
    if (changing.current) return false;
    changing.current = true;
    epoch.current++;
    polling.current?.abort();
    polling.current = null;
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    let needsRefresh = false;
    try {
      const next = await operation(controller.signal);
      if (!mounted.current) return false;
      const created = next?.parties.find(
        (party) =>
          !stateRef.current?.parties.some((old) => old.id === party.id),
      );
      if (created) setPartyId(created.id);
      applyState(next);
      setNotice(success);
      return true;
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return false;
      const failure =
        cause instanceof SocialApiError ? cause.code : "unavailable";
      setError(failure);
      if (failure === "session_required") applyState(null);
      needsRefresh =
        failure === "conflict" || failure === "constraint_conflict";
      return false;
    } finally {
      changing.current = false;
      if (mounted.current) {
        setBusy(false);
        setLoaded(true);
      }
      if (needsRefresh) void refresh(true);
    }
  }
  const mutate: Mutate = (action, success) =>
    change((signal) => api.action(action, signal), success);
  const text = (key: CopyKey) => say(locale, key);
  return (
    <section className="party-page" aria-label={t(locale, "party")}>
      <div className="party-intro">
        <Users size={24} />
        <h2>{text("intro")}</h2>
      </div>
      <p className="field-hint">{text("privacy")}</p>
      {error && (
        <p className="notice error" role="alert">
          {text(error)}
        </p>
      )}
      {notice && (
        <p className="party-notice" role="status">
          {text(notice)}
        </p>
      )}
      {busy && (
        <p className="small muted" role="status">
          {text("busy")}
        </p>
      )}
      {!loaded ? (
        <p className="loading-state" role="status">
          {text("loading")}
        </p>
      ) : !state ? (
        <form
          className="party-form"
          onSubmit={(event) => {
            event.preventDefault();
            void change((signal) => api.session(name, signal));
          }}
        >
          <label className="field">
            {text("name")}
            <input
              name="profile_name"
              autoComplete="given-name"
              value={name}
              maxLength={40}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button className="primary" disabled={busy || !name.trim()}>
            {text("createProfile")}
          </button>
        </form>
      ) : (
        <>
          <div className="profile-card">
            <span className="profile-avatar" aria-hidden="true">
              {state.profile.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{state.profile.name}</strong>
              <p>
                {text("expires")}: {dateTime(state.expires_at, locale)}
              </p>
            </div>
          </div>
          <div className="friend-code">
            <label className="field">
              {text("friendCode")}
              <input
                readOnly
                value={state.friend_code}
                onFocus={(event) => event.target.select()}
              />
            </label>
            <button
              className="icon-button"
              type="button"
              aria-label={text("copy")}
              onClick={() => {
                void navigator.clipboard?.writeText(state.friend_code).then(
                  () => setNotice("copied"),
                  () => setNotice("copyFailed"),
                );
                if (!navigator.clipboard) setNotice("copyFailed");
              }}
            >
              <Copy size={18} />
            </button>
          </div>
          <details
            className="party-section"
            open={
              state.friend_requests.length > 0 ||
              state.party_invites.length > 0 ||
              undefined
            }
          >
            <summary>
              {text("friends")}{" "}
              <span className="count">{state.friends.length}</span>
            </summary>
            <form
              className="party-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(
                  { action: "friend_request", code: code.trim() },
                  "requestSent",
                ).then((ok) => {
                  if (ok) setCode("");
                });
              }}
            >
              <label className="field">
                {text("enterCode")}
                <input
                  value={code}
                  maxLength={64}
                  required
                  autoComplete="off"
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <button className="secondary" disabled={busy || !code.trim()}>
                {text("addFriend")}
              </button>
            </form>
            {!state.friends.length && (
              <p className="field-hint">{text("noFriends")}</p>
            )}
            <ul className="party-people">
              {state.friend_requests.map((profile) => (
                <li key={`request-${profile.id}`}>
                  <strong>{profile.name}</strong>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void mutate({
                        action: "friend_accept",
                        profile_id: profile.id,
                      })
                    }
                  >
                    {text("accept")}
                  </button>
                </li>
              ))}
              {state.friends.map((profile) => (
                <li key={profile.id}>
                  <span>{profile.name}</span>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void mutate({
                        action: "friend_remove",
                        profile_id: profile.id,
                      })
                    }
                  >
                    {text("remove")}
                  </button>
                </li>
              ))}
              {state.party_invites.map((party) => (
                <li key={party.id}>
                  <div>
                    <strong>{party.name}</strong>
                    <small>{party.owner.name}</small>
                  </div>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void mutate({ action: "party_join", party_id: party.id })
                    }
                  >
                    {text("accept")}
                  </button>
                </li>
              ))}
            </ul>
          </details>
          <details
            className="party-section"
            open={!state.parties.length || undefined}
          >
            <summary>{text("newParty")}</summary>
            <form
              className="party-form"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate({
                  action: "party_create",
                  name: partyName.trim(),
                }).then((ok) => {
                  if (ok) setPartyName("");
                });
              }}
            >
              <label className="field">
                {text("partyName")}
                <input
                  value={partyName}
                  required
                  maxLength={60}
                  onChange={(event) => setPartyName(event.target.value)}
                />
              </label>
              <button className="primary" disabled={busy || !partyName.trim()}>
                {text("createParty")}
              </button>
            </form>
          </details>
          {state.parties.length > 1 && (
            <label className="field">
              {text("chooseParty")}
              <select
                value={active?.id ?? ""}
                onChange={(event) => setPartyId(event.target.value)}
              >
                {state.parties.map((party) => (
                  <option key={party.id} value={party.id}>
                    {party.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {active && (
            <PartyRoom
              key={active.id}
              party={active}
              state={state}
              mutate={mutate}
              busy={busy}
            />
          )}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void mutate({ action: "logout" })}
          >
            <LogOut size={16} />
            {text("signOut")}
          </button>
        </>
      )}
    </section>
  );
}

function Preferences({
  member,
  partyId,
  locale,
  busy,
  mutate,
}: {
  member: SocialMember;
  partyId: string;
  locale: Locale;
  busy: boolean;
  mutate: Mutate;
}) {
  const [minutes, setMinutes] = useState(String(member.available_seconds / 60));
  const [constraints, setConstraints] = useState<Constraint[]>(
    member.constraints,
  );
  const text = (key: CopyKey) => say(locale, key);
  return (
    <details className="party-section">
      <summary>{text("preferences")}</summary>
      <form
        className="party-form"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate({
            action: "preferences",
            party_id: partyId,
            available_seconds: Number(minutes) * 60,
            constraints,
          });
        }}
      >
        <label className="field">
          {text("minutes")}
          <input
            type="number"
            min="1"
            max="240"
            step="1"
            required
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
        <div className="constraint-list">
          {constraintKeys.map((key) => (
            <label key={key}>
              <span>{label(locale, key)}</span>
              <select
                value={
                  constraints.find(
                    (item) => item.key === key && item.value === true,
                  )?.strength ?? ""
                }
                onChange={(event) => {
                  const strength = event.target.value;
                  setConstraints((old) => [
                    ...old.filter((item) => item.key !== key),
                    ...(strength
                      ? [
                          {
                            key,
                            value: true,
                            strength: strength as "preferred" | "required",
                          },
                        ]
                      : []),
                  ]);
                }}
              >
                <option value="">{text("optional")}</option>
                <option value="preferred">{t(locale, "preferred")}</option>
                <option value="required">{t(locale, "required")}</option>
              </select>
            </label>
          ))}
        </div>
        <button className="secondary" disabled={busy}>
          {text("saveNeeds")}
        </button>
      </form>
    </details>
  );
}

function PartyRoom({
  party,
  state,
  mutate,
  busy,
}: {
  party: PartyState;
  state: SocialState;
  mutate: Mutate;
  busy: boolean;
}) {
  const { locale, currentRequest } = useSharedPlanner();
  const text = (key: CopyKey) => say(locale, key);
  const member = party.members.find(
    (item) => item.profile.id === state.profile.id,
  )!;
  const [invited, setInvited] = useState("");
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [selection, setSelection] = useState<{
    requestId: string;
    ids: string[];
  }>({ requestId: "", ids: [] });
  const response = party.recommendations;
  const chosen =
    selection.requestId === response?.request_id ? selection.ids : [];
  const eligible = state.friends.filter(
    (friend) => !party.members.some((item) => item.profile.id === friend.id),
  );
  function recommend() {
    const request = currentRequest();
    if (!request) {
      setSetupNeeded(true);
      return;
    }
    setSetupNeeded(false);
    void mutate({
      action: "recommend",
      party_id: party.id,
      revision: party.revision,
      request,
    });
  }
  return (
    <section className="party-room" aria-label={party.name}>
      <header className="party-heading">
        <div>
          <h2>{party.name}</h2>
          <p>
            {party.members.length} {text("memberCount")}
          </p>
        </div>
        <button
          className="icon-button"
          aria-label={text("leaveParty")}
          disabled={busy}
          onClick={() =>
            void mutate({ action: "party_leave", party_id: party.id })
          }
        >
          <LogOut size={18} />
        </button>
      </header>
      <ul className="party-members">
        {party.members.map((item) => (
          <li key={item.profile.id}>
            <span className="member-avatar" aria-hidden="true">
              {item.profile.name.slice(0, 1)}
            </span>
            <div>
              <strong>
                {item.profile.name}
                {item.profile.id === state.profile.id
                  ? ` · ${text("you")}`
                  : ""}
              </strong>
              <small>{duration(item.available_seconds, locale)}</small>
              {item.constraints.length > 0 && (
                <p>
                  {item.constraints
                    .map(
                      (c) =>
                        `${label(locale, c.key)} · ${t(locale, c.strength)}`,
                    )
                    .join("; ")}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {party.owner_id === state.profile.id &&
        eligible.length > 0 &&
        party.members.length < 5 && (
          <form
            className="party-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (invited)
                void mutate(
                  {
                    action: "party_invite",
                    party_id: party.id,
                    profile_id: invited,
                  },
                  "invited",
                );
            }}
          >
            <label className="field">
              {text("invite")}
              <select
                value={invited}
                onChange={(event) => setInvited(event.target.value)}
              >
                <option value="">—</option>
                {eligible.map((friend) => (
                  <option key={friend.id} value={friend.id}>
                    {friend.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="secondary" disabled={busy || !invited}>
              {text("invite")}
            </button>
          </form>
        )}
      <Preferences
        key={JSON.stringify([member.available_seconds, member.constraints])}
        member={member}
        partyId={party.id}
        locale={locale}
        busy={busy}
        mutate={mutate}
      />
      <p className="field-hint">{text("groupHint")}</p>
      <Link href="/walk" className="text-button" scroll={false}>
        {text("goWalk")}
      </Link>
      {setupNeeded && (
        <p className="notice amber" role="status">
          {text("planSetup")}
        </p>
      )}
      <button className="primary" disabled={busy} onClick={recommend}>
        <Users size={16} />
        {text("recommend")}
      </button>
      {response && (
        <section
          className="party-results"
          aria-label={t(locale, "recommendations")}
        >
          <Warnings warnings={response.warnings} locale={locale} />
          {response.recommendations.length === 0 ? (
            <p className="notice amber" role="status">
              {text("noMatch")}
            </p>
          ) : (
            <>
              <h3>{text("chooseStops")}</h3>
              <div className="result-cards">
                {response.recommendations.map((item) => {
                  const place = response.places.find(
                    (p) => p.id === item.place_id,
                  )!;
                  const index = chosen.indexOf(place.id);
                  return (
                    <article className="place-card" key={place.id}>
                      {place.is_synthetic && (
                        <span className="badge amber">
                          {t(locale, "synthetic")}
                        </span>
                      )}
                      <h3>{place.name}</h3>
                      <div className="why-summary">
                        <strong>{t(locale, "why")}</strong>
                        <p>{item.why}</p>
                      </div>
                      <p className="small">{item.suggested_activity}</p>
                      <p className="party-timing">
                        {duration(item.total_duration_seconds, locale)} ·{" "}
                        {t(locale, "travel")}{" "}
                        {duration(item.route.duration_seconds, locale)} ·{" "}
                        {t(locale, "visit")}{" "}
                        {duration(item.visit_duration_seconds, locale)}
                      </p>
                      <span
                        className={`badge ${item.route.method === "approximate" ? "amber" : "green"}`}
                      >
                        {t(
                          locale,
                          item.route.method === "approximate"
                            ? "approximate"
                            : "routed",
                        )}
                      </span>
                      <details className="why">
                        <summary>{t(locale, "sources")}</summary>
                        {item.constraint_evaluations.map((evaluation) => (
                          <p key={evaluation.key} className="small">
                            {label(locale, evaluation.key)} ·{" "}
                            {t(locale, evaluation.strength)} ·{" "}
                            {t(locale, evaluation.outcome)}
                          </p>
                        ))}
                        <Sources evidence={place.evidence} locale={locale} />
                      </details>
                      <button
                        className="secondary"
                        aria-pressed={index >= 0}
                        disabled={busy || (index < 0 && chosen.length >= 3)}
                        onClick={() =>
                          setSelection({
                            requestId: response.request_id,
                            ids:
                              index >= 0
                                ? chosen.filter((id) => id !== place.id)
                                : [...chosen, place.id],
                          })
                        }
                      >
                        {index >= 0 ? (
                          <>
                            <Check size={16} />
                            {index + 1}. {text("removeStop")}
                          </>
                        ) : (
                          text("add")
                        )}
                      </button>
                    </article>
                  );
                })}
              </div>
              <button
                className="primary"
                disabled={busy || !chosen.length}
                onClick={() =>
                  void mutate({
                    action: "itinerary",
                    party_id: party.id,
                    revision: party.revision,
                    request: { ...response.request, place_ids: chosen },
                  })
                }
              >
                {text("build")}
              </button>
            </>
          )}
        </section>
      )}
      {party.itinerary && (
        <section className="party-plan" aria-live="polite">
          <h3>{text("sharedPlan")}</h3>
          {party.itinerary.stops.length ? (
            <>
              <div className="journey-total">
                <strong>
                  {duration(party.itinerary.total_duration_seconds, locale)}
                </strong>
                <span>{t(locale, "total")}</span>
              </div>
              <ol className="itinerary-visits">
                {party.itinerary.stops.map((stop) => (
                  <li key={stop.place_id}>
                    <strong>
                      {
                        party.itinerary!.places.find(
                          (place) => place.id === stop.place_id,
                        )?.name
                      }
                    </strong>
                    <span>{duration(stop.visit_duration_seconds, locale)}</span>
                  </li>
                ))}
              </ol>
              {party.itinerary.route?.method === "approximate" && (
                <p className="badge amber">{t(locale, "approximate")}</p>
              )}
            </>
          ) : (
            <p className="notice amber">{text("noMatch")}</p>
          )}
          <Warnings warnings={party.itinerary.warnings} locale={locale} />
        </section>
      )}
      <PartyChat
        party={party}
        profileId={state.profile.id}
        locale={locale}
        busy={busy}
        mutate={mutate}
      />
      <p className="field-hint">{text("sharedSync")}</p>
    </section>
  );
}

function PartyChat({
  party,
  profileId,
  locale,
  busy,
  mutate,
}: {
  party: PartyState;
  profileId: string;
  locale: Locale;
  busy: boolean;
  mutate: Mutate;
}) {
  const text = (key: CopyKey) => say(locale, key);
  const [message, setMessage] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [localError, setLocalError] = useState<CopyKey | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const generation = useRef(0);
  const imageGeneration = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      imageGeneration.current++;
    },
    [],
  );
  const sharing = party.locations.find((item) => item.profile.id === profileId);
  async function attach(file: File | undefined) {
    if (!file) return;
    const stamp = ++imageGeneration.current;
    setPhotoBusy(true);
    setLocalError(null);
    try {
      const next = await encodeSharedPhoto(file);
      if (stamp === imageGeneration.current) setPhoto(next);
    } catch (cause) {
      if (stamp === imageGeneration.current)
        setLocalError(
          cause instanceof SocialApiError ? cause.code : "photo_type",
        );
    } finally {
      if (stamp === imageGeneration.current) setPhotoBusy(false);
    }
  }
  function locate() {
    const stamp = ++generation.current;
    setLocalError(null);
    if (!navigator.geolocation) {
      setLocalError("geoError");
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (stamp !== generation.current) return;
        setGeoBusy(false);
        void mutate({
          action: "location",
          party_id: party.id,
          coordinates: {
            lat: Number(position.coords.latitude.toFixed(6)),
            lon: Number(position.coords.longitude.toFixed(6)),
          },
        });
      },
      () => {
        if (stamp === generation.current) {
          setGeoBusy(false);
          setLocalError("geoError");
        }
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 0 },
    );
  }
  return (
    <>
      <section className="party-chat" aria-label={text("chat")}>
        <h3>{text("chat")}</h3>
        <p className="field-hint">{text("chatHint")}</p>
        <ol className="chat-messages" aria-label={text("chat")}>
          {party.messages.length ? (
            party.messages.map((item) => (
              <li
                key={item.id}
                className={item.author.id === profileId ? "own" : ""}
              >
                <div className="chat-meta">
                  <strong>{item.author.name}</strong>
                  <time dateTime={item.created_at}>
                    {dateTime(item.created_at, locale)}
                  </time>
                </div>
                {item.text && <p>{item.text}</p>}
                {item.photo && (
                  <Image
                    src={item.photo}
                    alt={text("photoAlt")}
                    width={480}
                    height={320}
                    unoptimized
                  />
                )}
              </li>
            ))
          ) : (
            <li className="chat-empty">{text("emptyChat")}</li>
          )}
        </ol>
        {localError && (
          <p className="notice error" role="alert">
            {text(localError)}
          </p>
        )}
        <form
          className="party-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate({
              action: "message",
              party_id: party.id,
              text: message.trim(),
              photo,
            }).then((ok) => {
              if (ok) {
                setMessage((current) => (current === message ? "" : current));
                setPhoto((current) => (current === photo ? null : current));
              }
            });
          }}
        >
          <label className="field">
            {text("message")}
            <textarea
              rows={2}
              maxLength={1000}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          {photo && (
            <div className="chat-preview">
              <Image
                src={photo}
                alt={text("preview")}
                width={480}
                height={320}
                unoptimized
              />
              <button
                className="icon-button"
                type="button"
                aria-label={text("removePhoto")}
                onClick={() => {
                  imageGeneration.current++;
                  setPhotoBusy(false);
                  setPhoto(null);
                }}
              >
                <X size={18} />
              </button>
            </div>
          )}
          <div className="chat-actions">
            <label className="secondary photo-input">
              <ImagePlus size={17} />
              {text("photo")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy || photoBusy}
                onChange={(event) => {
                  void attach(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
            <label className="secondary photo-input">
              <Camera size={17} />
              {text("capture")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                disabled={busy || photoBusy}
                onChange={(event) => {
                  void attach(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
            <button
              className="primary"
              disabled={busy || photoBusy || (!message.trim() && !photo)}
            >
              <Send size={16} />
              {text("send")}
            </button>
          </div>
          <p className="field-hint">{text("photoHint")}</p>
        </form>
      </section>
      <section className="party-location">
        <h3>{text("location")}</h3>
        <p className="field-hint">{text("locationHint")}</p>
        {geoBusy ? (
          <button
            className="secondary"
            onClick={() => {
              generation.current++;
              setGeoBusy(false);
            }}
          >
            {text("cancelLocation")}
          </button>
        ) : (
          <button className="secondary" disabled={busy} onClick={locate}>
            <LocateFixed size={16} />
            {text("shareLocation")}
          </button>
        )}
        {sharing && (
          <div className="location-sharing">
            <p className="small">
              {text("locationUntil")}: {dateTime(sharing.expires_at, locale)}
            </p>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                generation.current++;
                setGeoBusy(false);
                void mutate({
                  action: "location",
                  party_id: party.id,
                  coordinates: null,
                });
              }}
            >
              {text("stopLocation")}
            </button>
          </div>
        )}
        <ul className="party-people">
          {party.locations
            .filter((item) => item.profile.id !== profileId)
            .map((item) => (
              <li key={item.profile.id}>
                <span>{item.profile.name}</span>
                <small>
                  {text("locationUntil")}: {dateTime(item.expires_at, locale)}
                </small>
              </li>
            ))}
        </ul>
      </section>
    </>
  );
}
