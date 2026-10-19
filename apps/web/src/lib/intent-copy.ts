import { locales, type Locale } from "./i18n";
const copy = {
  scenarioFind: ["Найти места", "Орындарды табу", "Find places"],
  scenarioFinding: ["Ищем места…", "Орындар ізделуде…", "Finding places…"],
  scenarioKeyboard: [
    "Enter — найти места · Shift + Enter — новая строка",
    "Enter — орындарды табу · Shift + Enter — жаңа жол",
    "Enter to find places · Shift + Enter for a new line",
  ],
  scenarioDraft: [
    "Пожелание ещё не применено. Нажмите «Найти места»: поиск учтёт текст, выбранные условия, старт и время.",
    "Қалау әлі қолданылған жоқ. «Орындарды табу» түймесін басыңыз: іздеуде мәтін, таңдалған шарттар, бастау нүктесі мен уақыт ескеріледі.",
    "Your request has not been applied yet. Choose Find places to search with your text, selected settings, start and time budget.",
  ],
  scenarioPending: [
    "Пожелание отправлено. Подбираем места с выбранными условиями, стартом и временем…",
    "Қалау жіберілді. Таңдалған шарттар, бастау нүктесі мен уақыт бойынша орындар ізделуде…",
    "Request submitted. Finding places with your selected settings, start and time budget…",
  ],
  scenarioApplied: [
    "Пожелание применено. Варианты ниже учитывают выбранные условия, старт и время.",
    "Қалау қолданылды. Төмендегі нұсқаларда таңдалған шарттар, бастау нүктесі мен уақыт ескерілген.",
    "Request applied. The options below use your selected settings, start and time budget.",
  ],
  scenarioCount: ["Вариантов", "Нұсқалар саны", "Options"],
  scenarioDirty: [
    "Изменения ещё не применены. Нажмите «Найти места», чтобы обновить варианты.",
    "Өзгерістер әлі қолданылған жоқ. Нұсқаларды жаңарту үшін «Орындарды табу» түймесін басыңыз.",
    "Your changes have not been applied. Choose Find places to update the options.",
  ],
  scenarioNoMatch: [
    "Пожелание обработано. Подходящих мест не найдено; обязательные условия сохранены. Уточните текст, старт или настройки и повторите поиск.",
    "Қалау өңделді. Сәйкес орындар табылмады; міндетті шарттар сақталды. Мәтінді, бастау нүктесін немесе баптауларды нақтылап, қайта іздеңіз.",
    "Request processed. No suitable places found; must-haves were preserved. Adjust your text, start or settings and search again.",
  ],
  scenarioClarify: [
    "Пожелание получено. Ответьте на уточняющий вопрос ниже, чтобы продолжить подбор.",
    "Қалау алынды. Іздеуді жалғастыру үшін төмендегі нақтылау сұрағына жауап беріңіз.",
    "Request received. Answer the clarification question below to continue.",
  ],
  scenarioNeedsQuery: [
    "Напишите, куда хотите сходить, и нажмите «Найти места».",
    "Қайда барғыңыз келетінін жазып, «Орындарды табу» түймесін басыңыз.",
    "Describe where you would like to go, then choose Find places.",
  ],
  scenarioNeedsOrigin: [
    "Сначала выберите точку старта на карте или укажите своё местоположение. Затем нажмите «Найти места».",
    "Алдымен картадан бастау нүктесін таңдаңыз немесе орналасқан жеріңізді көрсетіңіз. Содан кейін «Орындарды табу» түймесін басыңыз.",
    "Choose a start on the map or use your location first, then choose Find places.",
  ],
  scenarioInvalid: [
    "Поиск не запущен. Проверьте координаты, время начала и длительность от 1 до 1440 минут.",
    "Іздеу басталмады. Координаттарды, басталу уақытын және 1–1440 минут аралығындағы ұзақтығын тексеріңіз.",
    "Search has not started. Check your coordinates, start time and a time budget from 1 to 1440 minutes.",
  ],
  scenarioError: [
    "Не удалось выполнить поиск. Проверьте сообщение об ошибке ниже и повторите поиск.",
    "Іздеу орындалмады. Төмендегі қате хабарламасын тексеріп, қайта іздеңіз.",
    "Search could not finish. Check the error below and try again.",
  ],
  analysisOnly: [
    "Необязательно: разберите текст, если хотите перенести из него время и условия в форму. Эта кнопка не запускает поиск мест.",
    "Қосымша: мәтіндегі уақыт пен шарттарды пішінге көшіру үшін талдаңыз. Бұл түйме орындарды іздеуді бастамайды.",
    "Optional: interpret the text to add time and constraints to the form. This button does not search for places.",
  ],
  analyze: [
    "Разобрать запрос с ИИ",
    "Сұрауды ЖИ арқылы талдау",
    "Interpret with AI",
  ],
  analyzing: [
    "Разбираем пожелание…",
    "Қалауыңыз талдануда…",
    "Interpreting your request…",
  ],
  review: [
    "Проверьте предложения",
    "Ұсыныстарды тексеріңіз",
    "Review suggestions",
  ],
  hint: [
    "Если подключён внешний ИИ, текст пожелания и язык отправляются настроенному провайдеру OpenAI или NVIDIA. Фото, чат и геокоординаты не добавляются; сведения, написанные вами в тексте, отправятся вместе с ним. Новые условия применятся после вашего подтверждения.",
    "Сыртқы ЖИ қосылған болса, сұрау мәтіні мен тілі бапталған OpenAI немесе NVIDIA провайдеріне жіберіледі. Фото, чат және геокоординаттар қосылмайды; мәтінге өзіңіз жазған мәліметтер онымен бірге жіберіледі. Жаңа шарттар сіз растағаннан кейін қолданылады.",
    "If external AI is connected, your request text and language are sent to the configured OpenAI or NVIDIA provider. Photos, chat and coordinates are not added; anything you write in the text is sent with it. New settings apply after your confirmation.",
  ],
  rules: [
    "Разбор по правилам",
    "Ережелер бойынша талдау",
    "Rule-based interpretation",
  ],
  model: ["Предложения ИИ", "ЖИ ұсыныстары", "AI suggestions"],
  useTime: ["Применить время", "Уақытты қолдану", "Apply time budget"],
  anchor: ["Упомянутое место", "Аталған орын", "Mentioned place"],
  anchorHint: [
    "Это текстовый ориентир. Выберите нужную точку старта на карте: координаты автоматически не меняются.",
    "Бұл мәтіндік бағдар. Картадан бастау нүктесін таңдаңыз: координаттар автоматты түрде өзгермейді.",
    "This is a text reference. Choose the intended start on the map; coordinates never change automatically.",
  ],
  categories: [
    "Интересы из текста",
    "Мәтіндегі қызығушылықтар",
    "Interests in your text",
  ],
  categoriesHint: [
    "Категории остаются подсказкой к пожеланию; отдельный фильтр не устанавливается.",
    "Санаттар сұрауға арналған ишара болып қалады; жеке сүзгі орнатылмайды.",
    "Categories describe your request; no separate category filter is set.",
  ],
  questions: ["Нужно уточнить", "Нақтылау қажет", "Please clarify"],
  apply: [
    "Применить выбранное",
    "Таңдалғанды қолдану",
    "Apply selected settings",
  ],
  applied: [
    "Настройки добавлены в форму. Поиск ещё не запущен: нажмите «Найти места».",
    "Баптаулар пішінге қосылды. Іздеу әлі басталған жоқ: «Орындарды табу» түймесін басыңыз.",
    "Settings added to the form. Search has not started yet; choose Find places.",
  ],
  preserved: [
    "Уже обязательные условия останутся обязательными. Неподтверждённое свойство места не считается выполненным.",
    "Міндетті шарттар міндетті болып қалады. Расталмаған орын қасиеті орындалған деп саналмайды.",
    "Existing must-haves stay required. An unknown place property does not satisfy a must-have.",
  ],
  noSettings: [
    "Новых условий или времени не найдено. Само пожелание можно использовать: нажмите «Найти места». Условия и время задайте в форме.",
    "Жаңа шарттар немесе уақыт табылмады. Қалауыңызды қолдануға болады: «Орындарды табу» түймесін басыңыз. Шарттар мен уақытты пішінде таңдаңыз.",
    "No new constraints or time budget found. You can still search with this request: choose Find places. Set constraints and time in the form.",
  ],
} as const;
export function intentText(locale: Locale, key: keyof typeof copy) {
  return copy[key][locales.indexOf(locale)];
}
