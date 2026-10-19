import type { Place } from "@astana/api-client";
import { label, locales, t, type Locale } from "./i18n";

export type PlaceFact = Place["facts"][number];
type Translations = readonly [string, string, string];
const labels: Record<string, Translations> = {
  opening_hours: [
    "Расписание из источника",
    "Дереккөздегі жұмыс кестесі",
    "Source opening hours",
  ],
  toilets: ["Туалет", "Дәретхана", "Toilets"],
  has_wifi: ["Wi-Fi", "Wi-Fi", "Wi-Fi"],
  "osm:cuisine": ["Кухня и меню", "Асүй және мәзір", "Cuisine and menu"],
  "osm:indoor_seating": [
    "Места для сидения внутри",
    "Ішіндегі отыратын орындар",
    "Indoor seating",
  ],
  "osm:outdoor_seating": [
    "Места для сидения снаружи",
    "Сырттағы отыратын орындар",
    "Outdoor seating",
  ],
  "osm:addr:city": ["Город", "Қала", "City"],
  "osm:addr:street": ["Улица", "Көше", "Street"],
  "osm:addr:housenumber": ["Номер дома", "Үй нөмірі", "House number"],
  "osm:addr:country": ["Страна", "Ел", "Country"],
  "osm:addr:postcode": ["Почтовый индекс", "Пошта индексі", "Postal code"],
  "osm:addr:unit": ["Помещение", "Бөлме", "Unit"],
  "osm:website": [
    "Сайт из источника",
    "Дереккөздегі сайт",
    "Source-listed website",
  ],
  "osm:contact:website": [
    "Сайт из контактов источника",
    "Дереккөздің байланыс сайты",
    "Source-listed contact website",
  ],
  "osm:wheelchair": [
    "Исходная отметка доступности",
    "Қолжетімділіктің бастапқы белгісі",
    "Original wheelchair tag",
  ],
  "osm:indoor": [
    "Исходная отметка помещения",
    "Ғимараттың бастапқы белгісі",
    "Original indoor tag",
  ],
  "osm:fee": [
    "Исходная отметка оплаты",
    "Төлемнің бастапқы белгісі",
    "Original fee tag",
  ],
  "osm:access": [
    "Исходная отметка доступа",
    "Кірудің бастапқы белгісі",
    "Original access tag",
  ],
  "osm:internet_access": [
    "Исходная отметка интернета",
    "Интернеттің бастапқы белгісі",
    "Original internet tag",
  ],
  "osm:internet_access:fee": [
    "Оплата интернета по источнику",
    "Дереккөздегі интернет төлемі",
    "Source internet fee",
  ],
  "osm:toilets": [
    "Исходная отметка туалета",
    "Дәретхананың бастапқы белгісі",
    "Original toilets tag",
  ],
  "osm:coordinate_kind": [
    "Тип точки на карте",
    "Карта нүктесінің түрі",
    "Map coordinate type",
  ],
  "osm:wikidata": ["Запись Wikidata", "Wikidata жазбасы", "Wikidata record"],
  "osm:wikipedia": [
    "Статья Wikipedia",
    "Wikipedia мақаласы",
    "Wikipedia article",
  ],
  "description:source": [
    "Источник описания",
    "Сипаттама дереккөзі",
    "Description source",
  ],
  "description:language": [
    "Язык исходного описания",
    "Бастапқы сипаттама тілі",
    "Original description language",
  ],
  "name:ru": ["Название на русском", "Орысша атауы", "Russian name"],
  "name:kk": ["Название на казахском", "Қазақша атауы", "Kazakh name"],
  "name:en": ["Название на английском", "Ағылшынша атауы", "English name"],
};
const cuisine: Record<string, Translations> = {
  coffee_shop: ["Кофе", "Кофе", "Coffee"],
  regional: ["Региональная кухня", "Өңірлік асүй", "Regional cuisine"],
  local: ["Местная кухня", "Жергілікті асүй", "Local cuisine"],
  breakfast: ["Завтраки", "Таңғы ас", "Breakfast"],
  pizza: ["Пицца", "Пицца", "Pizza"],
  italian_pizza: ["Итальянская пицца", "Италиялық пицца", "Italian pizza"],
  chinese: ["Китайская кухня", "Қытай асүйі", "Chinese cuisine"],
  italian: ["Итальянская кухня", "Италия асүйі", "Italian cuisine"],
  european: ["Европейская кухня", "Еуропа асүйі", "European cuisine"],
  oriental: ["Восточная кухня", "Шығыс асүйі", "Oriental cuisine"],
  japanese: ["Японская кухня", "Жапон асүйі", "Japanese cuisine"],
  asian: ["Азиатская кухня", "Азия асүйі", "Asian cuisine"],
  russian: ["Русская кухня", "Орыс асүйі", "Russian cuisine"],
  burger: ["Бургеры", "Бургерлер", "Burgers"],
  cake: ["Торты", "Торттар", "Cakes"],
  chicken: ["Блюда из курицы", "Тауық тағамдары", "Chicken dishes"],
  sushi: ["Суши", "Суши", "Sushi"],
  korean: ["Корейская кухня", "Корей асүйі", "Korean cuisine"],
  international: [
    "Международная кухня",
    "Халықаралық асүй",
    "International cuisine",
  ],
  georgian: ["Грузинская кухня", "Грузин асүйі", "Georgian cuisine"],
  pastry: ["Выпечка", "Пісірме өнімдер", "Pastries"],
  sandwich: ["Сэндвичи", "Сэндвичтер", "Sandwiches"],
  brunch: ["Бранч", "Бранч", "Brunch"],
  steak_house: ["Стейки", "Стейктер", "Steaks"],
  pasta: ["Паста", "Паста", "Pasta"],
  french: ["Французская кухня", "Француз асүйі", "French cuisine"],
};
const copy = {
  summary: [
    "Кратко по данным источников",
    "Дереккөздерден қысқаша",
    "At a glance, from sources",
  ],
  description: [
    "Описание из источника",
    "Дереккөздегі сипаттама",
    "Source description",
  ],
  noDescription: [
    "Источник не предоставил описание этого места.",
    "Дереккөз бұл орынның сипаттамасын бермеген.",
    "The source has not provided a description of this place.",
  ],
  sourceText: [
    "Текст сохранён на языке источника.",
    "Мәтін дереккөз тілінде сақталған.",
    "Text is kept in its source language.",
  ],
  address: ["Адрес", "Мекенжай", "Address"],
  scheduleNote: [
    "Расписание из источника не подтверждает работу на время вашего визита.",
    "Дереккөздегі кесте сіз баратын уақытта ашық болатынын растамайды.",
    "Source hours do not confirm opening during your visit.",
  ],
  amenities: [
    "Удобства и условия",
    "Қолайлылықтар мен талаптар",
    "Amenities and conditions",
  ],
  sourceDetails: [
    "Исходное значение и источник",
    "Бастапқы мән және дереккөз",
    "Original value and source",
  ],
  otherFacts: [
    "Другие сведения источника",
    "Дереккөздің өзге мәліметтері",
    "Other source records",
  ],
  unknownConditions: [
    "Есть неподтверждённые сведения",
    "Расталмаған мәліметтер бар",
    "Some details are unverified",
  ],
  sourceClaim: [
    "Это сведения источника, не проверка на месте.",
    "Бұл — дереккөз мәліметтері, орнында тексеру емес.",
    "These are source claims, not an on-site check.",
  ],
  aliases: ["Другие названия", "Басқа атаулары", "Other names"],
} satisfies Record<string, Translations>;

export function placeText(locale: Locale, key: keyof typeof copy): string {
  return copy[key][locales.indexOf(locale)];
}
export function factLabel(locale: Locale, key: string): string {
  if (labels[key]) return labels[key][locales.indexOf(locale)];
  if (/^(osm|wikidata):description:(ru|kk|en)$/.test(key))
    return `${placeText(locale, "description")} (${key.split(":").at(-1)})`;
  if (
    /^(osm:(alt_name|short_name|int_name)|wikidata:(aliases|label))/.test(key)
  )
    return `${placeText(locale, "aliases")} (${key})`;
  return label(locale, key);
}
export function rawFactValue(fact: PlaceFact): string {
  return Array.isArray(fact.value)
    ? fact.value.join(", ")
    : String(fact.value ?? "");
}
export function factValue(locale: Locale, fact: PlaceFact): string {
  if (typeof fact.value === "boolean")
    return t(locale, fact.value ? "yes" : "no");
  const raw = rawFactValue(fact);
  if (fact.key === "osm:cuisine")
    return raw
      .split(";")
      .map(
        (value) =>
          cuisine[value.trim().toLowerCase()]?.[locales.indexOf(locale)] ??
          value.trim().replaceAll("_", " "),
      )
      .join(", ");
  if (
    /^osm:(indoor_seating|outdoor_seating|fee|access|wheelchair|internet_access|internet_access:fee|toilets)$/.test(
      fact.key,
    )
  ) {
    if (raw === "yes" || raw === "no") return t(locale, raw);
    if (raw === "limited")
      return ["Частично", "Ішінара", "Limited"][locales.indexOf(locale)];
    if (raw === "wlan") return "Wi-Fi";
  }
  // Display only: do not calculate opening status or reinterpret exceptions.
  if (fact.key === "opening_hours") {
    const days: Record<string, Translations> = {
      Mo: ["Пн", "Дс", "Mon"],
      Tu: ["Вт", "Сс", "Tue"],
      We: ["Ср", "Ср", "Wed"],
      Th: ["Чт", "Бс", "Thu"],
      Fr: ["Пт", "Жм", "Fri"],
      Sa: ["Сб", "Сб", "Sat"],
      Su: ["Вс", "Жс", "Sun"],
    };
    return raw.replace(
      /\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g,
      (day) => days[day][locales.indexOf(locale)],
    );
  }
  if (fact.key === "osm:coordinate_kind") {
    if (raw === "node")
      return ["Точка OSM", "OSM нүктесі", "OSM point"][locales.indexOf(locale)];
    if (raw === "center" || raw === "bounding_box_center")
      return [
        "Центр объекта OSM",
        "OSM нысанының ортасы",
        "OSM feature center",
      ][locales.indexOf(locale)];
  }
  return raw;
}

export function sourcedFact(place: Place, key: string): PlaceFact | undefined {
  return place.facts.find(
    (fact) =>
      fact.key === key &&
      fact.status === "known" &&
      fact.evidence_ids.some((id) =>
        place.evidence.some((source) => source.id === id),
      ),
  );
}
export function sourceDescription(place: Place, locale: Locale) {
  const localized =
    sourcedFact(place, `osm:description:${locale}`) ??
    sourcedFact(place, `wikidata:description:${locale}`);
  const text =
    typeof localized?.value === "string" ? localized.value : place.description;
  if (!text) return null;
  const source = localized ?? sourcedFact(place, "description:source");
  return {
    text,
    localized: Boolean(localized),
    evidence: source
      ? place.evidence.filter((e) => source.evidence_ids.includes(e.id))
      : place.evidence,
  };
}
export const amenityKeys = [
  "wheelchair_accessible",
  "indoor",
  "free_entry",
  "child_friendly",
  "toilets",
  "has_wifi",
  "has_power_outlets",
  "quiet",
  "open_at_requested_time",
];
export const overviewKeys = [
  "opening_hours",
  "osm:cuisine",
  "osm:indoor_seating",
  "osm:outdoor_seating",
  "has_wifi",
  "toilets",
  "wheelchair_accessible",
  "free_entry",
];
export function primaryFact(fact: PlaceFact): boolean {
  return (
    amenityKeys.includes(fact.key) ||
    overviewKeys.includes(fact.key) ||
    /^osm:(addr:|website$|contact:website$)/.test(fact.key)
  );
}
