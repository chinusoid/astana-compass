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
  placesLegend: [
    "Значки — места по категориям",
    "Белгілер — санат бойынша орындар",
    "Symbols show place categories",
  ],
  stopsLegend: [
    "Числа — порядок остановок",
    "Сандар — аялдамалар реті",
    "Numbers show stop order",
  ],
  routeLegend: [
    "Линия и стрелки — путь по дорогам",
    "Сызық пен бағыттар — жол бойындағы бағыт",
    "Line and arrows follow the roads",
  ],
  overview: ["Весь маршрут", "Бүкіл маршрут", "Route overview"],
  firstStop: [
    "Это первый пункт назначения",
    "Бұл — бірінші баратын орын",
    "This is your first destination",
  ],
  destination: ["Пункт назначения", "Баратын орын", "Destination"],
  returnStart: [
    "Старт и финиш · возврат к началу",
    "Бастау және мәре · басына қайту",
    "Start and finish · return to origin",
  ],
  endRoute: ["Конец маршрута", "Маршруттың соңы", "Route finish"],
  fullDetails: [
    "Полная карточка места",
    "Орынның толық карточкасы",
    "Full place details",
  ],
  sourceClaim: [
    "Сведения из источника, не проверка на месте.",
    "Бұл — дереккөз мәліметі, орнында тексеру емес.",
    "Source information, not an on-site check.",
  ],
  addressUnknown: [
    "Адрес не указан в источнике",
    "Дереккөзде мекенжай көрсетілмеген",
    "No address supplied by the source",
  ],
  descriptionUnknown: [
    "Источник не предоставил описание. Откройте полную карточку для доступных сведений.",
    "Дереккөз сипаттама бермеген. Қолжетімді мәлімет үшін толық карточканы ашыңыз.",
    "The source has not supplied a description. Open full details for the available information.",
  ],
  inspectHint: [
    "Нажмите здание или точку карты, чтобы узнать о месте",
    "Орын туралы білу үшін ғимаратты немесе карта нүктесін басыңыз",
    "Click a building or map point to inspect it",
  ],
  inspectPrivacy: [
    "При нажатии координаты выбранной точки отправляются сервису OpenStreetMap для поиска сведений.",
    "Басқанда таңдалған нүкте координаттары мәлімет іздеу үшін OpenStreetMap қызметіне жіберіледі.",
    "Clicking sends the selected point's coordinates to the OpenStreetMap service to look up information.",
  ],
  contains: [
    "Объект в выбранной точке",
    "Таңдалған нүктедегі нысан",
    "Object at the selected point",
  ],
  nearbyMatch: [
    "Рядом с выбранной точкой",
    "Таңдалған нүктеге жақын",
    "Near the selected point",
  ],
  meters: ["м", "м", "m"],
  retrieved: [
    "Сведения загружены",
    "Мәлімет жүктелген уақыт",
    "Information retrieved",
  ],
  inspectDescriptionUnknown: [
    "В источнике нет описания этого объекта.",
    "Дереккөзде бұл нысан сипатталмаған.",
    "The source has no description for this object.",
  ],
  inspect: ["Что здесь находится", "Бұл жерде не бар", "What is here"],
  inspectCentre: [
    "Что в центре карты",
    "Карта ортасында не бар",
    "Inspect map centre",
  ],
  inspectLoading: [
    "Ищем сведения о выбранном объекте…",
    "Таңдалған нысан туралы мәлімет іздеудеміз…",
    "Looking up the selected object…",
  ],
  inspectEmpty: [
    "Для этой точки подробности в источнике не найдены. Это не означает, что здесь ничего нет.",
    "Бұл нүкте туралы дереккөзден мәлімет табылмады. Бұл жерде ештеңе жоқ деген сөз емес.",
    "No source details were found for this point. This does not mean there is nothing here.",
  ],
  inspectError: [
    "Не удалось загрузить сведения. Попробуйте снова.",
    "Мәлімет жүктелмеді. Қайта көріңіз.",
    "Could not load details. Try again.",
  ],
  inspectSlow: [
    "Сервис временно занят. Повторите через минуту.",
    "Қызмет уақытша бос емес. Бір минуттан кейін қайталаңыз.",
    "The service is temporarily busy. Try again in a minute.",
  ],
  inspectSource: ["Открыть источник", "Дереккөзді ашу", "Open source"],
  nearby: [
    "Объекты у выбранной точки",
    "Таңдалған нүкте маңындағы нысандар",
    "Objects near the selected point",
  ],
  markerGroup: ["Мест рядом", "Жақын орындар", "Nearby places"],
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
