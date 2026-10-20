import { locales, type Locale } from "./i18n";
const copy = {
  filters: ["Фильтры", "Сүзгілер", "Filters"],
  noFilters: ["Без фильтров", "Сүзгісіз", "No filters"],
  filterHint: [
    "По умолчанию ограничений нет. Время и пожелания из описания учитываются автоматически. Длительность из текста важнее поля ниже и остаётся ориентиром. Обязательные условия включайте только при необходимости.",
    "Әдепкіде шектеу жоқ. Мәтіндегі уақыт пен қалаулар автоматты ескеріледі. Мәтіндегі ұзақтық төмендегі өрістен маңыздырақ және бағдар болып қалады. Міндетті шарттарды қажет болса ғана қосыңыз.",
    "No restrictions by default. Time and wishes in your description are interpreted automatically. A duration in the text takes priority over the field below and remains a target. Add must-haves only when needed.",
  ],
  clearFilters: ["Сбросить фильтры", "Сүзгілерді тазалау", "Clear filters"],
  done: ["Готово", "Дайын", "Done"],
  noTime: ["Не ограничено", "Шектеусіз", "No time target"],
  queryHint: [
    "Расскажите, как хотите провести время: например, «кофе, затем парк на два часа». Описание — главное, маршрут появится на карте автоматически.",
    "Уақытты қалай өткізгіңіз келетінін жазыңыз: мысалы, «кофе, сосын саябақта екі сағат». Мәтін — басты бағдар, бағыт картада автоматты көрінеді.",
    "Describe your walk, for example ‘coffee, then a park for two hours’. Your description leads the search; the route appears on the map automatically.",
  ],
  interpreting: [
    "Учитываем пожелание…",
    "Қалауыңыз ескерілуде…",
    "Interpreting your walk…",
  ],
  routing: [
    "Соединяем остановки маршрутом…",
    "Аялдамалар бағытқа қосылуда…",
    "Connecting your stops…",
  ],
  ready: [
    "Ваша прогулка на карте",
    "Серуеніңіз картада",
    "Your walk is on the map",
  ],
  routeFailed: [
    "Не удалось соединить остановки. План сохранён.",
    "Аялдамалар қосылмады. Жоспар сақталды.",
    "The path could not be built. Your stops are saved.",
  ],
  plan: ["План прогулки", "Серуен жоспары", "Your walk"],
  inferred: ["Учли из описания", "Мәтіннен ескерілді", "From your description"],
  intentFallback: [
    "Подбираем по вашему тексту. Отдельный разбор условий сейчас недоступен — их можно указать в фильтрах.",
    "Мәтініңіз бойынша іздейміз. Шарттарды бөлек талдау қазір қолжетімсіз — оларды сүзгілерде беруге болады.",
    "Searching with your text. Separate interpretation is unavailable; additional settings can be added in Filters.",
  ],
  aiPrivacy: [
    "При поиске текст пожелания и язык могут обрабатываться подключённым ИИ. Координаты для разбора текста не передаются.",
    "Іздеу кезінде мәтін мен тілді қосылған ЖИ өңдеуі мүмкін. Мәтінді талдауға координаттар жіберілмейді.",
    "Your description and language may be processed by the connected AI. Coordinates are not sent for text interpretation.",
  ],
  advancedIntent: [
    "Проверить разбор текста отдельно",
    "Мәтін талдауын бөлек тексеру",
    "Review text interpretation separately",
  ],
  remove: ["Убрать остановку", "Аялдаманы алып тастау", "Remove stop"],
  viewRoute: ["Весь маршрут", "Толық бағыт", "Whole route"],
  coffeePark: [
    "Сначала выпить кофе, затем погулять в парке",
    "Алдымен кофе, содан кейін саябақта серуендеу",
    "Coffee first, then a walk in a park",
  ],
  night: [
    "Прогуляться и посмотреть красивую архитектуру вечером",
    "Кешке әдемі сәулетті тамашалап серуендеу",
    "An evening walk to see beautiful architecture",
  ],
  river: [
    "Прогуляться по живописным местам вдоль реки",
    "Өзен бойындағы көрікті жерлерде серуендеу",
    "A scenic walk along the river",
  ],
} as const;
export function walkText(locale: Locale, key: keyof typeof copy): string {
  return copy[key][locales.indexOf(locale)];
}
