import type { Locale } from "./i18n";

const copy = {
  privacyLabel: ["О карте", "Карта туралы", "About map"],
  title: ["Карта Астаны", "Астана картасы", "Astana map"],
  hint: [
    "Места, старт и проверенный маршрут",
    "Орындар, бастау нүктесі және тексерілген маршрут",
    "Places, starting point and verified route",
  ],
  controls: ["Управление картой", "Картаны басқару", "Map controls"],
  mode2d: ["Плоская карта — 2D", "Жазық карта — 2D", "Flat map — 2D"],
  mode3d: [
    "Объёмные здания — 3D",
    "Көлемді ғимараттар — 3D",
    "Building volumes — 3D",
  ],
  recenter: [
    "Вернуться к центру Астаны",
    "Астана орталығына оралу",
    "Return to central Astana",
  ],
  zoomIn: ["Приблизить", "Жақындату", "Zoom in"],
  zoomOut: ["Отдалить", "Алыстату", "Zoom out"],
  north: ["Повернуть на север", "Солтүстікке бұру", "Reset bearing to north"],
  attribution: ["Источники карты", "Карта дереккөздері", "Map attribution"],
  interactive: [
    "Карта Астаны. Стрелки перемещают карту, плюс и минус меняют масштаб.",
    "Астана картасы. Бағыт пернелері картаны жылжытады, плюс пен минус масштабты өзгертеді.",
    "Astana map. Arrow keys pan, plus and minus zoom.",
  ],
  keyboard: [
    "Можно переместить карту стрелками и подтвердить точку в центре.",
    "Картаны бағыт пернелерімен жылжытып, ортасындағы нүктені растауға болады.",
    "Pan with the arrow keys, then confirm the point at the centre.",
  ],
  picking: [
    "Нажмите на карту, чтобы выбрать старт",
    "Бастау нүктесін таңдау үшін картаны басыңыз",
    "Click the map to choose a starting point",
  ],
  confirm: [
    "Начать из центра карты",
    "Карта орталығынан бастау",
    "Start from the map centre",
  ],
  selected: [
    "Точка старта выбрана",
    "Бастау нүктесі таңдалды",
    "Starting point selected",
  ],
  start: ["Точка старта", "Бастау нүктесі", "Starting point"],
  place: ["Открыть место", "Орынды ашу", "Open place"],
  loading: [
    "Загружаем карту Астаны…",
    "Астана картасы жүктелуде…",
    "Loading Astana’s map…",
  ],
  load: ["Загрузить карту", "Картаны жүктеу", "Load map"],
  privacy: [
    "Подложка загружается у провайдера карты. Он получает IP и область просмотра, но не текст запроса или выбранные места.",
    "Карта қабаты карта провайдерінен жүктеледі. Ол IP мен көрініс аймағын алады, бірақ сұрау мәтінін не таңдалған орындарды алмайды.",
    "The basemap provider receives your IP and map viewport, but not your query text or selected places.",
  ],
  offline: [
    "Подложка отключена. Внешние тайлы не загружаются.",
    "Карта қабаты өшірулі. Сыртқы тайлдар жүктелмейді.",
    "Basemap disabled. No external tiles are loaded.",
  ],
  failed: [
    "Карта не загрузилась. Список мест и параметры прогулки остаются доступны.",
    "Карта жүктелмеді. Орындар тізімі мен серуен параметрлері қолжетімді.",
    "The map could not load. Places and walk settings remain available.",
  ],
  transient: [
    "Часть карты временно недоступна. Уже загруженные участки остаются на экране.",
    "Картаның бір бөлігі уақытша қолжетімсіз. Жүктелген бөліктер экранда қалады.",
    "Some map tiles are temporarily unavailable. Loaded areas remain visible.",
  ],
  retry: ["Повторить загрузку", "Қайта жүктеу", "Retry loading"],
  heights: [
    "Высоты зданий ориентировочные: данные OpenStreetMap и оценки провайдера.",
    "Ғимарат биіктіктері шамамен берілген: OpenStreetMap деректері және провайдер бағалары.",
    "Building heights are indicative: OpenStreetMap data and provider estimates.",
  ],
  no3d: [
    "Объёмные здания недоступны для этой подложки.",
    "Бұл карта қабатында көлемді ғимараттар қолжетімсіз.",
    "This basemap does not provide building volumes.",
  ],
  issue: [
    "Сообщить об ошибке карты",
    "Карта қатесін хабарлау",
    "Report a map issue",
  ],
  motion: ["Демо движения", "Қозғалыс үлгісі", "Motion demo"],
  simulation: [
    "Симуляция машин и пешеходов. Это не данные о пробках или людях в реальном времени.",
    "Көліктер мен жаяу жүргіншілер симуляциясы. Бұл нақты уақыттағы кептеліс не адамдар туралы дерек емес.",
    "Simulated cars and pedestrians. This is not live traffic or people data.",
  ],
  motionPaused: [
    "Анимация приостановлена: включено уменьшение движения или вкладка скрыта.",
    "Анимация кідіртілді: қозғалысты азайту қосылған немесе бет жасырылған.",
    "Animation paused for reduced motion or a hidden tab.",
  ],
  motionEmpty: [
    "На загруженном участке пока нет подходящих линий дорог и дорожек для симуляции.",
    "Жүктелген аймақта симуляцияға жарамды жолдар мен соқпақтар әлі жоқ.",
    "No suitable road or path geometry is loaded in this view yet.",
  ],
  cars: ["Машины", "Көліктер", "Cars"],
  walkers: ["Пешеходы", "Жаяу жүргіншілер", "Pedestrians"],
  community: [
    "Событие сообщества · не проверено",
    "Қауымдастық іс-шарасы · тексерілмеген",
    "Community event · unverified",
  ],
  shared: [
    "Участник поделился местоположением",
    "Қатысушы орналасқан жерін бөлісті",
    "Location shared by a member",
  ],
  closePopup: [
    "Закрыть сведения на карте",
    "Картадағы мәліметті жабу",
    "Close map details",
  ],
} satisfies Record<string, readonly [string, string, string]>;

export function mapText(locale: Locale, key: keyof typeof copy): string {
  return copy[key][locale === "ru" ? 0 : locale === "kk" ? 1 : 2];
}
