import { locales, type Locale } from "./i18n";
const copy = {
  intro: [
    "Объявления участников на карте. Автор указывает место и время; сервис не проверяет событие и его доступность.",
    "Қатысушылардың картадағы хабарландырулары. Орын мен уақытты автор көрсетеді; сервис оқиғаны және қолжетімділікті тексермейді.",
    "Community announcements on the map. Authors provide the location and time; events and accessibility are unverified.",
  ],
  newEvent: ["Добавить событие", "Оқиға қосу", "Add an event"],
  signIn: [
    "Укажите имя в разделе «Компания», чтобы добавлять свои события.",
    "Оқиға қосу үшін «Топ» бөлімінде атыңызды енгізіңіз.",
    "Set a name in Together to add your own events.",
  ],
  openParty: ["Перейти в компанию", "Топ бөліміне өту", "Open Together"],
  title: ["Название события", "Оқиға атауы", "Event title"],
  description: ["Описание", "Сипаттамасы", "Description"],
  start: ["Начало · Астана", "Басталуы · Астана", "Starts · Astana"],
  end: ["Окончание · Астана", "Аяқталуы · Астана", "Ends · Astana"],
  point: [
    "Будет опубликована выбранная на карте точка",
    "Картадан таңдалған нүкте жарияланады",
    "The selected map point will be published",
  ],
  noPoint: [
    "Сначала выберите точку события на карте или введите координаты выше.",
    "Алдымен картадан оқиға нүктесін таңдаңыз немесе жоғарыда координаттарды енгізіңіз.",
    "Choose the event point on the map or enter coordinates above.",
  ],
  publish: ["Опубликовать событие", "Оқиғаны жариялау", "Publish event"],
  published: [
    "Событие опубликовано как непроверенное объявление участника.",
    "Оқиға қатысушының тексерілмеген хабарландыруы ретінде жарияланды.",
    "Event published as an unverified community announcement.",
  ],
  deleted: [
    "Ваше событие удалено",
    "Оқиғаңыз жойылды",
    "Your event was deleted",
  ],
  delete: ["Удалить моё событие", "Оқиғамды жою", "Delete my event"],
  unverified: [
    "Не проверено · объявление участника",
    "Тексерілмеген · қатысушы хабарландыруы",
    "Unverified · community announcement",
  ],
  author: ["Автор", "Автор", "Author"],
  publishedAt: ["Опубликовано", "Жарияланған", "Published"],
  empty: [
    "Пока нет объявлений о событиях",
    "Оқиғалар туралы хабарландырулар әзірге жоқ",
    "No event announcements yet",
  ],
  refresh: ["Обновить события", "Оқиғаларды жаңарту", "Refresh events"],
  required: [
    "Заполните название, описание и точку. Окончание должно быть позже начала.",
    "Атауды, сипаттаманы және нүктені толтырыңыз. Аяқталу уақыты басталуынан кейін болуы керек.",
    "Enter a title, description and location. End time must be after the start.",
  ],
  failed: [
    "Не удалось обновить события. Попробуйте ещё раз.",
    "Оқиғаларды жаңарту мүмкін болмады. Қайталап көріңіз.",
    "Could not update events. Please try again.",
  ],
  expired: [
    "Сессия закончилась. Укажите имя в разделе «Компания».",
    "Сессия аяқталды. «Топ» бөлімінде атыңызды енгізіңіз.",
    "Your session expired. Set a name in Together.",
  ],
  checking: [
    "Проверяем сессию…",
    "Сессия тексерілуде…",
    "Checking your session…",
  ],
  public: [
    "Название, описание, имя автора, точка и время будут видны всем пользователям. Объявления хранятся временно в памяти демо-сервера.",
    "Атауы, сипаттамасы, автордың аты, нүкте мен уақыт барлық пайдаланушыға көрінеді. Хабарландырулар демо-сервер жадында уақытша сақталады.",
    "The title, description, author name, point and time will be public. Announcements are temporary and stored in the demo server's memory.",
  ],
} as const;
export function eventText(locale: Locale, key: keyof typeof copy) {
  return copy[key][locales.indexOf(locale)];
}
