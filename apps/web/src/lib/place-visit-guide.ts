import type { Evidence, Place } from "@astana/api-client";
import { safeUrl } from "./format";
import { type Locale, locales } from "./i18n";
import { factLabel, factValue, sourcedFact } from "./place-presentation";

type Translation = readonly [string, string, string];
const copy = {
  practical: [
    "Полезно перед визитом",
    "Барар алдында пайдалы",
    "Plan your visit",
  ],
  address: ["Адрес", "Мекенжай", "Address"],
  hours: [
    "Расписание из источника",
    "Дереккөздегі кесте",
    "Source opening hours",
  ],
  contacts: ["Быстрые ссылки", "Жылдам сілтемелер", "Quick links"],
  officialWebsite: ["Официальный сайт", "Ресми сайт", "Official website"],
  sourceWebsite: [
    "Сайт из источника",
    "Дереккөздегі сайт",
    "Source-listed website",
  ],
  sourcePage: ["Страница источника", "Дереккөз беті", "Source page"],
  menu: ["Меню из источника", "Дереккөздегі мәзір", "Source-listed menu"],
  phone: ["Позвонить", "Қоңырау шалу", "Call"],
  email: ["Написать", "Хат жазу", "Email"],
  map: [
    "Место в OpenStreetMap",
    "Орын OpenStreetMap-та",
    "Place on OpenStreetMap",
  ],
  highlights: ["Что посмотреть", "Не көруге болады", "What to see"],
  amenities: [
    "Условия по данным источников",
    "Дереккөздегі жағдайлар",
    "Source-listed conditions",
  ],
  before: ["Перед посещением", "Барар алдында", "Before visiting"],
  idea: ["Идея для посещения", "Бару идеясы", "An idea for your visit"],
  estimate: ["Время на знакомство", "Танысуға уақыт", "Time to explore"],
  estimateNote: [
    "Ориентир для планирования, без учёта переходов. Длительность спектакля, экскурсии или другого события сюда не входит.",
    "Жол уақытын қоспағандағы жоспарлау бағдары. Спектакль, экскурсия немесе өзге іс-шараның ұзақтығы кірмейді.",
    "A planning estimate, excluding travel. It does not include a show, guided tour or another event.",
  ],
  planEstimateNote: [
    "Оценка времени посещения в текущем плане, без учёта переходов. Фактическая длительность может отличаться.",
    "Қазіргі жоспардағы бару уақытының бағасы, жол уақыты кірмейді. Нақты ұзақтығы өзгеше болуы мүмкін.",
    "The visit estimate in your current plan, excluding travel. Actual duration may differ.",
  ],
  ideaNote: [
    "Предложение по категории места, а не подтверждённая услуга.",
    "Орын санатына сай ұсыныс, расталған қызмет емес.",
    "A category-based suggestion, not a confirmed service.",
  ],
  minutes: ["мин", "мин", "min"],
  rating: ["Оценка в источнике", "Дереккөздегі баға", "Source rating"],
  fee: [
    "Оплата входа по источнику",
    "Дереккөздегі кіру ақысы",
    "Source admission fee tag",
  ],
  access: ["Условия доступа", "Кіру шарттары", "Access conditions"],
  contactNote: [
    "Перед выходом уточните часы, стоимость и условия посещения на сайте места или по телефону.",
    "Шығар алдында уақытын, бағасын және бару шарттарын орынның сайтынан немесе телефонмен нақтылаңыз.",
    "Before leaving, check hours, prices and visiting conditions on the venue website or by phone.",
  ],
  records: [
    "Все сведения и источники",
    "Барлық мәлімет пен дереккөздер",
    "All records and sources",
  ],
  conflicts: [
    "В источниках есть расхождения",
    "Дереккөздерде қайшылықтар бар",
    "Sources contain conflicting details",
  ],
} satisfies Record<string, Translation>;

export function visitText(locale: Locale, key: keyof typeof copy): string {
  return copy[key][locales.indexOf(locale)];
}

export type VisitRecord = {
  key: string;
  label: string;
  value: string;
  evidence: Evidence[];
};
export type VisitAction = {
  kind: "website" | "menu" | "phone" | "email" | "map";
  label: string;
  href: string;
  detail?: string;
};

function records(
  place: Place,
  locale: Locale,
  keys: readonly string[],
): VisitRecord[] {
  return keys.flatMap((key) => {
    const fact = sourcedFact(place, key);
    if (!fact || fact.value === null || factValue(locale, fact).trim() === "")
      return [];
    return [
      {
        key,
        label:
          key === "osm:fee"
            ? visitText(locale, "fee")
            : key === "osm:access"
              ? visitText(locale, "access")
              : factLabel(locale, key),
        value: factValue(locale, fact),
        evidence: place.evidence.filter((source) =>
          fact.evidence_ids.includes(source.id),
        ),
      },
    ];
  });
}

function website(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 2048 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? safeUrl(value)
    : undefined;
}

export function placeVisitActions(place: Place, locale: Locale): VisitAction[] {
  const result: VisitAction[] = [];
  const official = place.evidence
    .filter(
      (source) => source.source_type === "official" && !source.is_synthetic,
    )
    .map((source) => website(source.source_url))
    .filter((url): url is string => Boolean(url));
  const operatorFact = sourcedFact(place, "official:website");
  const operatorWebsite = operatorFact?.evidence_ids.some((id) =>
    place.evidence.some(
      (source) =>
        source.id === id &&
        source.source_type === "official" &&
        !source.is_synthetic,
    ),
  )
    ? website(operatorFact.value)
    : undefined;
  const linkedWebsite = ["osm:website", "osm:contact:website"]
    .map((key) => website(sourcedFact(place, key)?.value))
    .find(Boolean);
  const site = operatorWebsite ?? linkedWebsite ?? official[0];
  if (site)
    result.push({
      kind: "website",
      href: site,
      label: visitText(
        locale,
        operatorWebsite
          ? "officialWebsite"
          : linkedWebsite
            ? "sourceWebsite"
            : "sourcePage",
      ),
    });
  const menu = website(sourcedFact(place, "osm:website:menu")?.value);
  if (menu && menu !== site)
    result.push({ kind: "menu", href: menu, label: visitText(locale, "menu") });

  for (const key of ["official:phone", "osm:phone", "osm:contact:phone"]) {
    const value = sourcedFact(place, key)?.value;
    if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value))
      continue;
    const phone = value
      .split(";")
      .map((item) => item.trim())
      .find(
        (item) =>
          /^\+?[\d ().-]{7,40}$/.test(item) &&
          /^\d{7,15}$/.test(item.replace(/\D/g, "")),
      );
    if (!phone) continue;
    result.push({
      kind: "phone",
      label: visitText(locale, "phone"),
      href: `tel:${phone.replace(/[^+\d]/g, "")}`,
      detail: phone,
    });
    break;
  }
  for (const key of ["osm:email", "osm:contact:email", "official:email"]) {
    const value = sourcedFact(place, key)?.value;
    if (
      typeof value !== "string" ||
      value.length > 254 ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      !/^[A-Za-z0-9.!#$%&'*+/=_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(
        value,
      )
    )
      continue;
    result.push({
      kind: "email",
      label: visitText(locale, "email"),
      href: `mailto:${value.split("@").map(encodeURIComponent).join("@")}`,
      detail: value,
    });
    break;
  }
  if (
    !place.is_synthetic &&
    /^osm:(?:node|way|relation)\/[1-9]\d*$/.test(place.id)
  ) {
    const expected = `https://www.openstreetmap.org/${place.id.slice(4)}`;
    if (
      place.evidence.some(
        (source) =>
          !source.is_synthetic &&
          source.source_type === "osm" &&
          source.source_url === expected,
      )
    )
      result.push({
        kind: "map",
        label: visitText(locale, "map"),
        href: expected,
      });
  }
  return result;
}

const ideas = {
  park: [
    [
      "Прогуляйтесь по территории и выберите место для короткой паузы. Отдельные объекты парка лучше проверить заранее.",
      "Аумақты аралап, қысқа демалысқа орын таңдаңыз. Саябақтың жеке нысандарын алдын ала тексерген дұрыс.",
      "Explore the grounds and choose a spot for a short break. Check access to individual park facilities in advance.",
    ],
    [30, 60],
  ],
  cafe: [
    [
      "Сделайте паузу за напитком и выберите заказ по актуальному меню. Наличие конкретных блюд уточните на месте.",
      "Сусын ішіп демалыңыз және қазіргі мәзірден таңдаңыз. Нақты тағамдардың барын сол жерде сұраңыз.",
      "Take a drink break and choose from the current menu. Ask the venue about specific items.",
    ],
    [15, 30],
  ],
  restaurant: [
    [
      "Запланируйте остановку на еду, посмотрите актуальное меню и уточните время ожидания.",
      "Тамақтануға аялдап, қазіргі мәзір мен күту уақытын нақтылаңыз.",
      "Plan a meal stop, browse the current menu and check the waiting time.",
    ],
    [30, 60],
  ],
  museum: [
    [
      "Выберите интересующую экспозицию. Перед входом уточните доступные залы, билеты и время последнего входа.",
      "Қызықты экспозицияны таңдаңыз. Кірер алдында ашық залдарды, билетті және соңғы кіру уақытын нақтылаңыз.",
      "Choose an exhibition that interests you. Check available galleries, tickets and last admission before entering.",
    ],
    [45, 90],
  ],
  theatre: [
    [
      "Рассмотрите архитектуру снаружи. Для посещения постановки отдельно проверьте афишу, билеты и продолжительность.",
      "Сыртқы сәулетін тамашалаңыз. Қойылымға бару үшін афишаны, билетті және ұзақтығын бөлек тексеріңіз.",
      "Look at the architecture from outside. For a performance, check the programme, tickets and running time separately.",
    ],
    [15, 30],
  ],
  library: [
    [
      "Уточните правила входа для посетителей и выберите книгу, выставку или доступную читальную зону.",
      "Келушілерге кіру ережесін нақтылап, кітап, көрме немесе қолжетімді оқу аймағын таңдаңыз.",
      "Check visitor entry rules and choose a book, exhibition or available reading area.",
    ],
    [20, 40],
  ],
  gallery: [
    [
      "Посмотрите, какая выставка проходит сейчас, и выберите несколько работ для внимательного знакомства.",
      "Қазір қандай көрме өтіп жатқанын тексеріп, мұқият қарауға бірнеше жұмыс таңдаңыз.",
      "Check the current exhibition and choose a few works to explore in detail.",
    ],
    [30, 60],
  ],
  default: [
    [
      "Сделайте остановку, осмотритесь и выберите интересный ракурс. Доступ внутрь и дополнительные услуги уточните заранее.",
      "Аялдап, айналаны қарап, қызықты көрініс таңдаңыз. Ішке кіру мен қосымша қызметтерді алдын ала нақтылаңыз.",
      "Pause, look around and find an interesting viewpoint. Check indoor access and extra services in advance.",
    ],
    [15, 30],
  ],
} as const;

export function placeVisitGuide(place: Place, locale: Locale) {
  const officialAddress = records(place, locale, ["official:address"])[0];
  const address = records(place, locale, [
    "osm:addr:street",
    "osm:addr:housenumber",
    "osm:addr:unit",
    "osm:addr:city",
  ]);
  const hours = records(place, locale, [
    "opening_hours",
    "official:published_hours",
    "official:greenhouse_hours",
    "official:greenhouse_entry_hours",
    "official:ticket_office_hours",
  ]);
  const practical = records(place, locale, [
    "osm:cuisine",
    "osm:indoor_seating",
    "osm:outdoor_seating",
    "osm:fee",
    "osm:access",
  ]);
  const amenities = records(place, locale, [
    "wheelchair_accessible",
    "free_entry",
    "toilets",
    "has_wifi",
    "child_friendly",
    "has_power_outlets",
    "quiet",
    "indoor",
  ]);
  const highlights = records(place, locale, [
    "official:highlights",
    "official:architecture",
    "official:waterfront",
    "official:greenhouse",
    "official:walking_paths",
    "official:cycle_paths",
    "official:running_paths",
    "official:playground",
    "official:fountains",
  ]).filter((item) => sourcedFact(place, item.key)?.value !== false);
  const notes = records(place, locale, ["official:visitor_note"]);
  // Hotel stars and an unscaled number are not a visitor rating.
  const rating = records(place, locale, [
    "official:rating",
    "osm:rating",
    "rating",
  ]).find((item) =>
    /^(?:[0-4](?:[.,]\d{1,2})?|5(?:[.,]0{1,2})?)\s*\/\s*5$/.test(
      item.value.trim(),
    ),
  );
  const kind = place.categories.find((category) =>
    Object.hasOwn(ideas, category),
  ) as keyof typeof ideas | undefined;
  const [idea, minutes] =
    ideas[kind ?? (place.categories.includes("garden") ? "park" : "default")];
  return {
    address:
      officialAddress?.value ?? address.map((part) => part.value).join(", "),
    hours,
    practical,
    amenities,
    highlights,
    notes,
    rating,
    actions: placeVisitActions(place, locale),
    idea: idea[locales.indexOf(locale)],
    estimate: `${minutes[0]}–${minutes[1]} ${visitText(locale, "minutes")}`,
  };
}
