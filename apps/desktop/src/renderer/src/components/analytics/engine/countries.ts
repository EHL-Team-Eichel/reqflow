/**
 * Country recognition for the analytics engine. A country column is read by rules only: a value
 * is a country when it is an ISO 3166-1 code or a known name, never a guess. Unknown values stay
 * unknown.
 */

/**
 * Reporting region of a country. China is a region of its own because BMW reports it as a market;
 * "Other" holds the codes the rules do not place (Antarctica, the sub-Antarctic territories).
 */
export type CountryRegion =
  | "Europe"
  | "China"
  | "North America"
  | "Asia-Pacific"
  | "Middle East & Africa"
  | "Latin America"
  | "Other";

/** A recognised country: ISO alpha-2 code, English short name and reporting region. */
export interface CountryInfo {
  code: string;
  name: string;
  region: CountryRegion;
}

/** One row per ISO 3166-1 country: alpha-2, alpha-3, English short name, region. */
const COUNTRY_ROWS: readonly (readonly [string, string, string, CountryRegion])[] = [
  ["AF", "AFG", "Afghanistan", "Middle East & Africa"],
  ["AX", "ALA", "Åland Islands", "Europe"],
  ["AL", "ALB", "Albania", "Europe"],
  ["DZ", "DZA", "Algeria", "Middle East & Africa"],
  ["AS", "ASM", "American Samoa", "Asia-Pacific"],
  ["AD", "AND", "Andorra", "Europe"],
  ["AO", "AGO", "Angola", "Middle East & Africa"],
  ["AI", "AIA", "Anguilla", "Latin America"],
  ["AQ", "ATA", "Antarctica", "Other"],
  ["AG", "ATG", "Antigua and Barbuda", "Latin America"],
  ["AR", "ARG", "Argentina", "Latin America"],
  ["AM", "ARM", "Armenia", "Europe"],
  ["AW", "ABW", "Aruba", "Latin America"],
  ["AU", "AUS", "Australia", "Asia-Pacific"],
  ["AT", "AUT", "Austria", "Europe"],
  ["AZ", "AZE", "Azerbaijan", "Europe"],
  ["BS", "BHS", "Bahamas", "Latin America"],
  ["BH", "BHR", "Bahrain", "Middle East & Africa"],
  ["BD", "BGD", "Bangladesh", "Asia-Pacific"],
  ["BB", "BRB", "Barbados", "Latin America"],
  ["BY", "BLR", "Belarus", "Europe"],
  ["BE", "BEL", "Belgium", "Europe"],
  ["BZ", "BLZ", "Belize", "Latin America"],
  ["BJ", "BEN", "Benin", "Middle East & Africa"],
  ["BM", "BMU", "Bermuda", "North America"],
  ["BT", "BTN", "Bhutan", "Asia-Pacific"],
  ["BO", "BOL", "Bolivia", "Latin America"],
  ["BQ", "BES", "Bonaire, Sint Eustatius and Saba", "Latin America"],
  ["BA", "BIH", "Bosnia and Herzegovina", "Europe"],
  ["BW", "BWA", "Botswana", "Middle East & Africa"],
  ["BV", "BVT", "Bouvet Island", "Other"],
  ["BR", "BRA", "Brazil", "Latin America"],
  ["IO", "IOT", "British Indian Ocean Territory", "Other"],
  ["BN", "BRN", "Brunei", "Asia-Pacific"],
  ["BG", "BGR", "Bulgaria", "Europe"],
  ["BF", "BFA", "Burkina Faso", "Middle East & Africa"],
  ["BI", "BDI", "Burundi", "Middle East & Africa"],
  ["CV", "CPV", "Cabo Verde", "Middle East & Africa"],
  ["KH", "KHM", "Cambodia", "Asia-Pacific"],
  ["CM", "CMR", "Cameroon", "Middle East & Africa"],
  ["CA", "CAN", "Canada", "North America"],
  ["KY", "CYM", "Cayman Islands", "Latin America"],
  ["CF", "CAF", "Central African Republic", "Middle East & Africa"],
  ["TD", "TCD", "Chad", "Middle East & Africa"],
  ["CL", "CHL", "Chile", "Latin America"],
  ["CN", "CHN", "China", "China"],
  ["CX", "CXR", "Christmas Island", "Asia-Pacific"],
  ["CC", "CCK", "Cocos (Keeling) Islands", "Asia-Pacific"],
  ["CO", "COL", "Colombia", "Latin America"],
  ["KM", "COM", "Comoros", "Middle East & Africa"],
  ["CG", "COG", "Congo", "Middle East & Africa"],
  ["CD", "COD", "DR Congo", "Middle East & Africa"],
  ["CK", "COK", "Cook Islands", "Asia-Pacific"],
  ["CR", "CRI", "Costa Rica", "Latin America"],
  ["CI", "CIV", "Côte d'Ivoire", "Middle East & Africa"],
  ["HR", "HRV", "Croatia", "Europe"],
  ["CU", "CUB", "Cuba", "Latin America"],
  ["CW", "CUW", "Curaçao", "Latin America"],
  ["CY", "CYP", "Cyprus", "Europe"],
  ["CZ", "CZE", "Czechia", "Europe"],
  ["DK", "DNK", "Denmark", "Europe"],
  ["DJ", "DJI", "Djibouti", "Middle East & Africa"],
  ["DM", "DMA", "Dominica", "Latin America"],
  ["DO", "DOM", "Dominican Republic", "Latin America"],
  ["EC", "ECU", "Ecuador", "Latin America"],
  ["EG", "EGY", "Egypt", "Middle East & Africa"],
  ["SV", "SLV", "El Salvador", "Latin America"],
  ["GQ", "GNQ", "Equatorial Guinea", "Middle East & Africa"],
  ["ER", "ERI", "Eritrea", "Middle East & Africa"],
  ["EE", "EST", "Estonia", "Europe"],
  ["SZ", "SWZ", "Eswatini", "Middle East & Africa"],
  ["ET", "ETH", "Ethiopia", "Middle East & Africa"],
  ["FK", "FLK", "Falkland Islands", "Latin America"],
  ["FO", "FRO", "Faroe Islands", "Europe"],
  ["FJ", "FJI", "Fiji", "Asia-Pacific"],
  ["FI", "FIN", "Finland", "Europe"],
  ["FR", "FRA", "France", "Europe"],
  ["GF", "GUF", "French Guiana", "Latin America"],
  ["PF", "PYF", "French Polynesia", "Asia-Pacific"],
  ["TF", "ATF", "French Southern Territories", "Other"],
  ["GA", "GAB", "Gabon", "Middle East & Africa"],
  ["GM", "GMB", "Gambia", "Middle East & Africa"],
  ["GE", "GEO", "Georgia", "Europe"],
  ["DE", "DEU", "Germany", "Europe"],
  ["GH", "GHA", "Ghana", "Middle East & Africa"],
  ["GI", "GIB", "Gibraltar", "Europe"],
  ["GR", "GRC", "Greece", "Europe"],
  ["GL", "GRL", "Greenland", "North America"],
  ["GD", "GRD", "Grenada", "Latin America"],
  ["GP", "GLP", "Guadeloupe", "Latin America"],
  ["GU", "GUM", "Guam", "Asia-Pacific"],
  ["GT", "GTM", "Guatemala", "Latin America"],
  ["GG", "GGY", "Guernsey", "Europe"],
  ["GN", "GIN", "Guinea", "Middle East & Africa"],
  ["GW", "GNB", "Guinea-Bissau", "Middle East & Africa"],
  ["GY", "GUY", "Guyana", "Latin America"],
  ["HT", "HTI", "Haiti", "Latin America"],
  ["HM", "HMD", "Heard Island and McDonald Islands", "Other"],
  ["VA", "VAT", "Holy See", "Europe"],
  ["HN", "HND", "Honduras", "Latin America"],
  ["HK", "HKG", "Hong Kong", "Asia-Pacific"],
  ["HU", "HUN", "Hungary", "Europe"],
  ["IS", "ISL", "Iceland", "Europe"],
  ["IN", "IND", "India", "Asia-Pacific"],
  ["ID", "IDN", "Indonesia", "Asia-Pacific"],
  ["IR", "IRN", "Iran", "Middle East & Africa"],
  ["IQ", "IRQ", "Iraq", "Middle East & Africa"],
  ["IE", "IRL", "Ireland", "Europe"],
  ["IM", "IMN", "Isle of Man", "Europe"],
  ["IL", "ISR", "Israel", "Middle East & Africa"],
  ["IT", "ITA", "Italy", "Europe"],
  ["JM", "JAM", "Jamaica", "Latin America"],
  ["JP", "JPN", "Japan", "Asia-Pacific"],
  ["JE", "JEY", "Jersey", "Europe"],
  ["JO", "JOR", "Jordan", "Middle East & Africa"],
  ["KZ", "KAZ", "Kazakhstan", "Asia-Pacific"],
  ["KE", "KEN", "Kenya", "Middle East & Africa"],
  ["KI", "KIR", "Kiribati", "Asia-Pacific"],
  ["KP", "PRK", "North Korea", "Asia-Pacific"],
  ["KR", "KOR", "South Korea", "Asia-Pacific"],
  ["KW", "KWT", "Kuwait", "Middle East & Africa"],
  ["KG", "KGZ", "Kyrgyzstan", "Asia-Pacific"],
  ["LA", "LAO", "Laos", "Asia-Pacific"],
  ["LV", "LVA", "Latvia", "Europe"],
  ["LB", "LBN", "Lebanon", "Middle East & Africa"],
  ["LS", "LSO", "Lesotho", "Middle East & Africa"],
  ["LR", "LBR", "Liberia", "Middle East & Africa"],
  ["LY", "LBY", "Libya", "Middle East & Africa"],
  ["LI", "LIE", "Liechtenstein", "Europe"],
  ["LT", "LTU", "Lithuania", "Europe"],
  ["LU", "LUX", "Luxembourg", "Europe"],
  ["MO", "MAC", "Macao", "Asia-Pacific"],
  ["MG", "MDG", "Madagascar", "Middle East & Africa"],
  ["MW", "MWI", "Malawi", "Middle East & Africa"],
  ["MY", "MYS", "Malaysia", "Asia-Pacific"],
  ["MV", "MDV", "Maldives", "Asia-Pacific"],
  ["ML", "MLI", "Mali", "Middle East & Africa"],
  ["MT", "MLT", "Malta", "Europe"],
  ["MH", "MHL", "Marshall Islands", "Asia-Pacific"],
  ["MQ", "MTQ", "Martinique", "Latin America"],
  ["MR", "MRT", "Mauritania", "Middle East & Africa"],
  ["MU", "MUS", "Mauritius", "Middle East & Africa"],
  ["YT", "MYT", "Mayotte", "Middle East & Africa"],
  ["MX", "MEX", "Mexico", "North America"],
  ["FM", "FSM", "Micronesia", "Asia-Pacific"],
  ["MD", "MDA", "Moldova", "Europe"],
  ["MC", "MCO", "Monaco", "Europe"],
  ["MN", "MNG", "Mongolia", "Asia-Pacific"],
  ["ME", "MNE", "Montenegro", "Europe"],
  ["MS", "MSR", "Montserrat", "Latin America"],
  ["MA", "MAR", "Morocco", "Middle East & Africa"],
  ["MZ", "MOZ", "Mozambique", "Middle East & Africa"],
  ["MM", "MMR", "Myanmar", "Asia-Pacific"],
  ["NA", "NAM", "Namibia", "Middle East & Africa"],
  ["NR", "NRU", "Nauru", "Asia-Pacific"],
  ["NP", "NPL", "Nepal", "Asia-Pacific"],
  ["NL", "NLD", "Netherlands", "Europe"],
  ["NC", "NCL", "New Caledonia", "Asia-Pacific"],
  ["NZ", "NZL", "New Zealand", "Asia-Pacific"],
  ["NI", "NIC", "Nicaragua", "Latin America"],
  ["NE", "NER", "Niger", "Middle East & Africa"],
  ["NG", "NGA", "Nigeria", "Middle East & Africa"],
  ["NU", "NIU", "Niue", "Asia-Pacific"],
  ["NF", "NFK", "Norfolk Island", "Asia-Pacific"],
  ["MK", "MKD", "North Macedonia", "Europe"],
  ["MP", "MNP", "Northern Mariana Islands", "Asia-Pacific"],
  ["NO", "NOR", "Norway", "Europe"],
  ["OM", "OMN", "Oman", "Middle East & Africa"],
  ["PK", "PAK", "Pakistan", "Asia-Pacific"],
  ["PW", "PLW", "Palau", "Asia-Pacific"],
  ["PS", "PSE", "Palestine", "Middle East & Africa"],
  ["PA", "PAN", "Panama", "Latin America"],
  ["PG", "PNG", "Papua New Guinea", "Asia-Pacific"],
  ["PY", "PRY", "Paraguay", "Latin America"],
  ["PE", "PER", "Peru", "Latin America"],
  ["PH", "PHL", "Philippines", "Asia-Pacific"],
  ["PN", "PCN", "Pitcairn", "Asia-Pacific"],
  ["PL", "POL", "Poland", "Europe"],
  ["PT", "PRT", "Portugal", "Europe"],
  ["PR", "PRI", "Puerto Rico", "Latin America"],
  ["QA", "QAT", "Qatar", "Middle East & Africa"],
  ["RE", "REU", "Réunion", "Middle East & Africa"],
  ["RO", "ROU", "Romania", "Europe"],
  ["RU", "RUS", "Russia", "Europe"],
  ["RW", "RWA", "Rwanda", "Middle East & Africa"],
  ["BL", "BLM", "Saint Barthélemy", "Latin America"],
  ["SH", "SHN", "Saint Helena, Ascension and Tristan da Cunha", "Middle East & Africa"],
  ["KN", "KNA", "Saint Kitts and Nevis", "Latin America"],
  ["LC", "LCA", "Saint Lucia", "Latin America"],
  ["MF", "MAF", "Saint Martin", "Latin America"],
  ["PM", "SPM", "Saint Pierre and Miquelon", "North America"],
  ["VC", "VCT", "Saint Vincent and the Grenadines", "Latin America"],
  ["WS", "WSM", "Samoa", "Asia-Pacific"],
  ["SM", "SMR", "San Marino", "Europe"],
  ["ST", "STP", "São Tomé and Príncipe", "Middle East & Africa"],
  ["SA", "SAU", "Saudi Arabia", "Middle East & Africa"],
  ["SN", "SEN", "Senegal", "Middle East & Africa"],
  ["RS", "SRB", "Serbia", "Europe"],
  ["SC", "SYC", "Seychelles", "Middle East & Africa"],
  ["SL", "SLE", "Sierra Leone", "Middle East & Africa"],
  ["SG", "SGP", "Singapore", "Asia-Pacific"],
  ["SX", "SXM", "Sint Maarten", "Latin America"],
  ["SK", "SVK", "Slovakia", "Europe"],
  ["SI", "SVN", "Slovenia", "Europe"],
  ["SB", "SLB", "Solomon Islands", "Asia-Pacific"],
  ["SO", "SOM", "Somalia", "Middle East & Africa"],
  ["ZA", "ZAF", "South Africa", "Middle East & Africa"],
  ["GS", "SGS", "South Georgia and the South Sandwich Islands", "Other"],
  ["SS", "SSD", "South Sudan", "Middle East & Africa"],
  ["ES", "ESP", "Spain", "Europe"],
  ["LK", "LKA", "Sri Lanka", "Asia-Pacific"],
  ["SD", "SDN", "Sudan", "Middle East & Africa"],
  ["SR", "SUR", "Suriname", "Latin America"],
  ["SJ", "SJM", "Svalbard and Jan Mayen", "Europe"],
  ["SE", "SWE", "Sweden", "Europe"],
  ["CH", "CHE", "Switzerland", "Europe"],
  ["SY", "SYR", "Syria", "Middle East & Africa"],
  ["TW", "TWN", "Taiwan", "Asia-Pacific"],
  ["TJ", "TJK", "Tajikistan", "Asia-Pacific"],
  ["TZ", "TZA", "Tanzania", "Middle East & Africa"],
  ["TH", "THA", "Thailand", "Asia-Pacific"],
  ["TL", "TLS", "Timor-Leste", "Asia-Pacific"],
  ["TG", "TGO", "Togo", "Middle East & Africa"],
  ["TK", "TKL", "Tokelau", "Asia-Pacific"],
  ["TO", "TON", "Tonga", "Asia-Pacific"],
  ["TT", "TTO", "Trinidad and Tobago", "Latin America"],
  ["TN", "TUN", "Tunisia", "Middle East & Africa"],
  ["TR", "TUR", "Türkiye", "Europe"],
  ["TM", "TKM", "Turkmenistan", "Asia-Pacific"],
  ["TC", "TCA", "Turks and Caicos Islands", "Latin America"],
  ["TV", "TUV", "Tuvalu", "Asia-Pacific"],
  ["UG", "UGA", "Uganda", "Middle East & Africa"],
  ["UA", "UKR", "Ukraine", "Europe"],
  ["AE", "ARE", "United Arab Emirates", "Middle East & Africa"],
  ["GB", "GBR", "United Kingdom", "Europe"],
  ["US", "USA", "United States", "North America"],
  ["UM", "UMI", "United States Minor Outlying Islands", "Other"],
  ["UY", "URY", "Uruguay", "Latin America"],
  ["UZ", "UZB", "Uzbekistan", "Asia-Pacific"],
  ["VU", "VUT", "Vanuatu", "Asia-Pacific"],
  ["VE", "VEN", "Venezuela", "Latin America"],
  ["VN", "VNM", "Vietnam", "Asia-Pacific"],
  ["VG", "VGB", "British Virgin Islands", "Latin America"],
  ["VI", "VIR", "U.S. Virgin Islands", "Latin America"],
  ["WF", "WLF", "Wallis and Futuna", "Asia-Pacific"],
  ["EH", "ESH", "Western Sahara", "Middle East & Africa"],
  ["YE", "YEM", "Yemen", "Middle East & Africa"],
  ["ZM", "ZMB", "Zambia", "Middle East & Africa"],
  ["ZW", "ZWE", "Zimbabwe", "Middle East & Africa"],
];

/** German names: all European countries plus the BMW markets and other large economies. */
const GERMAN_NAMES: Readonly<Record<string, string>> = {
  AD: "Andorra",
  AL: "Albanien",
  AM: "Armenien",
  AT: "Österreich",
  AX: "Åland",
  AZ: "Aserbaidschan",
  BA: "Bosnien und Herzegowina",
  BE: "Belgien",
  BG: "Bulgarien",
  BY: "Weißrussland",
  CH: "Schweiz",
  CY: "Zypern",
  CZ: "Tschechien",
  DE: "Deutschland",
  DK: "Dänemark",
  EE: "Estland",
  ES: "Spanien",
  FI: "Finnland",
  FO: "Färöer",
  FR: "Frankreich",
  GB: "Vereinigtes Königreich",
  GE: "Georgien",
  GG: "Guernsey",
  GI: "Gibraltar",
  GR: "Griechenland",
  HR: "Kroatien",
  HU: "Ungarn",
  IE: "Irland",
  IM: "Insel Man",
  IS: "Island",
  IT: "Italien",
  JE: "Jersey",
  LI: "Liechtenstein",
  LT: "Litauen",
  LU: "Luxemburg",
  LV: "Lettland",
  MC: "Monaco",
  MD: "Moldau",
  ME: "Montenegro",
  MK: "Nordmazedonien",
  MT: "Malta",
  NL: "Niederlande",
  NO: "Norwegen",
  PL: "Polen",
  PT: "Portugal",
  RO: "Rumänien",
  RS: "Serbien",
  RU: "Russland",
  SE: "Schweden",
  SI: "Slowenien",
  SJ: "Svalbard und Jan Mayen",
  SK: "Slowakei",
  SM: "San Marino",
  TR: "Türkei",
  UA: "Ukraine",
  VA: "Vatikanstadt",
  AE: "Vereinigte Arabische Emirate",
  AU: "Australien",
  BR: "Brasilien",
  CA: "Kanada",
  CN: "China",
  EG: "Ägypten",
  HK: "Hongkong",
  IL: "Israel",
  IN: "Indien",
  JP: "Japan",
  KP: "Nordkorea",
  KR: "Südkorea",
  KZ: "Kasachstan",
  MX: "Mexiko",
  NZ: "Neuseeland",
  SA: "Saudi-Arabien",
  SG: "Singapur",
  TW: "Taiwan",
  US: "Vereinigte Staaten",
  ZA: "Südafrika",
};

/** Other spellings and codes, each mapped to the alpha-2 code it stands for (UK, EU code EL, colloquial names). */
const ALIASES: Readonly<Record<string, string>> = {
  UK: "GB",
  "Great Britain": "GB",
  Britain: "GB",
  England: "GB",
  Scotland: "GB",
  Wales: "GB",
  "Northern Ireland": "GB",
  Großbritannien: "GB",
  USA: "US",
  "U.S.": "US",
  "U.S.A.": "US",
  "United States of America": "US",
  "Vereinigte Staaten von Amerika": "US",
  EL: "GR",
  Holland: "NL",
  PRC: "CN",
  "Mainland China": "CN",
  "People's Republic of China": "CN",
  "Republic of China": "TW",
  "Taiwan, Province of China": "TW",
  Korea: "KR",
  "Republic of Korea": "KR",
  "Korea, Republic of": "KR",
  "Czech Republic": "CZ",
  "Tschechische Republik": "CZ",
  Oesterreich: "AT",
  Turkey: "TR",
  "Russian Federation": "RU",
  Macedonia: "MK",
  "Ivory Coast": "CI",
  Burma: "MM",
  "Viet Nam": "VN",
  "Cape Verde": "CV",
  Swaziland: "SZ",
  "East Timor": "TL",
  "Lao PDR": "LA",
  Eire: "IE",
  "Vatican City": "VA",
  "State of Palestine": "PS",
  Macau: "MO",
  Hongkong: "HK",
  "Brunei Darussalam": "BN",
  "Democratic Republic of the Congo": "CD",
  DRC: "CD",
  Bosnia: "BA",
  "Bosnia-Herzegovina": "BA",
  "St. Lucia": "LC",
  UAE: "AE",
  GER: "DE",
  BRD: "DE",
  "Bundesrepublik Deutschland": "DE",
};

const BY_CODE = new Map<string, CountryInfo>();
const CODE_BY_ALPHA3 = new Map<string, string>();
const CODE_BY_NAME = new Map<string, string>();
const CODE_BY_ALIAS = new Map<string, string>();

for (const [code, alpha3, name, region] of COUNTRY_ROWS) {
  BY_CODE.set(code, { code, name, region });
  CODE_BY_ALPHA3.set(alpha3, code);
  CODE_BY_NAME.set(fold(name), code);
}
for (const [code, name] of Object.entries(GERMAN_NAMES)) CODE_BY_NAME.set(fold(name), code);
for (const [alias, code] of Object.entries(ALIASES)) CODE_BY_ALIAS.set(fold(alias), code);

/**
 * Lowercase, no diacritics, ß as ss, curly apostrophes straight, no dots, single spaces: the form
 * every lookup compares.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[’‘]/g, "'")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function infoFor(code: string): CountryInfo | null {
  const found = BY_CODE.get(code);
  return found ? { ...found } : null;
}

/**
 * Recognises a country by ISO alpha-2 or alpha-3 code, English or German name, or a known alias.
 * Returns null for anything else, including region codes such as "EU", "EMEA" or "World".
 */
export function normalizeCountry(value: unknown): CountryInfo | null {
  if (typeof value !== "string") return null;
  const key = fold(value);
  if (key === "") return null;
  const upper = key.toUpperCase();
  const code =
    (key.length === 2 && BY_CODE.has(upper) ? upper : undefined) ??
    (key.length === 3 ? CODE_BY_ALPHA3.get(upper) : undefined) ??
    CODE_BY_ALIAS.get(key) ??
    CODE_BY_NAME.get(key);
  return code === undefined ? null : infoFor(code);
}

/** English name for a known alpha-2 code (case-insensitive); otherwise returns the input unchanged. */
export function countryName(code: string): string {
  return BY_CODE.get(code.trim().toUpperCase())?.name ?? code;
}

/** Region for a known alpha-2 code; "Other" when the code is unknown. */
export function countryRegion(code: string): CountryRegion {
  return BY_CODE.get(code.trim().toUpperCase())?.region ?? "Other";
}

/**
 * Share (0–1) of the non-empty values that normalizeCountry recognises. Empty input gives 0.
 * A list value counts each of its entries.
 */
export function countryRecognitionRate(values: readonly unknown[]): number {
  let total = 0;
  let recognised = 0;
  for (const value of values.flatMap((v): unknown[] => (Array.isArray(v) ? v : [v]))) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    total += 1;
    if (normalizeCountry(value) !== null) recognised += 1;
  }
  return total === 0 ? 0 : recognised / total;
}

/** Header names that name a country column, once normalised (lowercase, no spaces, "_" or "-"). */
const COUNTRY_HEADERS = new Set([
  "country",
  "countrycode",
  "land",
  "market",
  "marketcode",
  "markt",
  "nation",
  "countryname",
  "iso",
  "isocode",
  "laendercode",
  "ländercode",
]);

/**
 * How likely a column header is a country column: 1 for an exact synonym, 0.5 when "country" or
 * "land" is a word part of the header, 0 otherwise. Region columns do not count.
 */
export function countryColumnScore(header: string): number {
  const lower = header.toLowerCase();
  if (COUNTRY_HEADERS.has(lower.replace(/[\s_-]/g, ""))) return 1;
  const words = lower.split(/[^\p{L}]+/u);
  const partial =
    lower.includes("country") ||
    lower.includes("countries") ||
    words.some((w) => w === "land" || (w.endsWith("land") && w !== "island"));
  return partial ? 0.5 : 0;
}
