import { locales, type Locale } from "./i18n";
const copy = {
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
    "Настройки обновлены. Проверьте их ниже и запустите подбор.",
    "Баптаулар жаңартылды. Төменде тексеріп, іздеуді бастаңыз.",
    "Settings updated. Review them below and start your search.",
  ],
  preserved: [
    "Уже обязательные условия останутся обязательными. Неподтверждённое свойство места не считается выполненным.",
    "Міндетті шарттар міндетті болып қалады. Расталмаған орын қасиеті орындалған деп саналмайды.",
    "Existing must-haves stay required. An unknown place property does not satisfy a must-have.",
  ],
  noSettings: [
    "Новых условий или времени не найдено. Уточните пожелание или заполните форму вручную.",
    "Жаңа шарттар немесе уақыт табылмады. Қалауыңызды нақтылаңыз немесе пішінді қолмен толтырыңыз.",
    "No new constraints or time budget found. Clarify your request or use the form.",
  ],
} as const;
export function intentText(locale: Locale, key: keyof typeof copy) {
  return copy[key][locales.indexOf(locale)];
}
