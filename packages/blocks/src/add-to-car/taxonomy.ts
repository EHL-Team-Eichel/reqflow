import type { KanoClass, RequirementCategory } from "@reqflow/core";

/**
 * Deterministic two-level theme taxonomy: component (what part of the car) › aspect (what about it).
 * "Seat squeaks", "squeaky seat" and BMW's tag "Seats : Noise" all land in one theme, Seats › Noise.
 * Polarity (complaint / request / praise) is kept separately, so one theme shows both sides.
 *
 * Rules are generic word patterns, not lists of BMW labels. `vfc` patterns match BMW's VFC
 * classification names (level 2 → component, level 3 → aspect); first match in array order wins.
 * `text` patterns match normalized comment text; every match counts.
 */

export type Polarity = "negative" | "positive" | "request";

/** Whole-word, case-insensitive pattern that also works for umlauts ("für", "Sitzhöhe"). */
export function words(alternatives: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, "iu");
}

export interface ComponentRule {
  id: string;
  label: string;
  /** Requirement category in @reqflow/core, or null when it depends on the aspect. */
  area: RequirementCategory | null;
  /** Set when the whole component is out of the briefing's scope. */
  outOfScope?: string;
  vfc?: RegExp;
  text?: RegExp;
}

export interface AspectRule {
  id: string;
  label: string;
  /** Noun phrase used in finding statements: "customers complain about <topic>". */
  topic: string;
  /** Imperative used in requirement titles: "<Component>: <action>". */
  action: string;
  kano: KanoClass;
  /** Requirement category when the component doesn't fix one (Vehicle overall). */
  area: RequirementCategory;
  outOfScope?: string;
  vfc?: RegExp;
  text?: RegExp;
}

const PRICING = "Pricing and value for money are out of scope for requirements (briefing).";

export const COMPONENTS: ComponentRule[] = [
  {
    id: "safety",
    label: "Safety systems & restraints",
    area: "driver_assistance",
    vfc: /airbag|seat belt|child restraint|child safety|impression of safety|vehicle safety|emergency request/i,
    text: words("airbags?|seat_belt|child_seat|isofix|safety|sicherheit\\p{L}*|gurt\\p{L}*"),
  },
  {
    id: "phone_connectivity",
    label: "Phone, CarPlay & connectivity",
    area: "infotainment_digital",
    vfc: /carplay|android auto|bluetooth|mobile device|usb|wi-?fi|esim|telephone|screen mirroring/i,
    text: words(
      "carplay|android auto|bluetooth|phones?|smartphones?|connectivity|iphone|wireless charg\\p{L}*|charging pad|usb|wi-?fi|hotspot|esim",
    ),
  },
  {
    id: "ev_charging",
    label: "Electric range, battery & charging",
    area: "range_charging",
    vfc: /electric range|high.voltage|charg|wallbox|bidirectional|brake energy regeneration/i,
    text: words(
      "range|kwh|charg(?:e|es|ed|ing|er|ers)|wallbox|supercharg\\p{L}*|regen\\p{L}*|recuperation|ev|reichweite|lade\\p{L}*",
    ),
  },
  {
    id: "voice_assistant",
    label: "Voice control & assistant",
    area: "infotainment_digital",
    vfc: /personal assistant|voice control|speech/i,
    text: words("voice|speech|hey bmw|personal assistant|sprachsteuerung|sprachassistent"),
  },
  {
    id: "connected_services",
    label: "App, remote & connected services",
    area: "infotainment_digital",
    vfc: /my bmw|mini app|connecteddrive services|connecteddrive upgrades|bmw online|customer account|portal|teleservices|remote software upgrade|remote services|caring car|driver's guide|apps \(smartphone\)|remote engine start \(my bmw|remote 3d view|remote interior camera/i,
    text: words(
      "my bmw|connected services|apps?|remote start|remote|subscriptions?|software updates?|ota|over the air|abo\\p{L}*",
    ),
  },
  {
    id: "access_keys",
    label: "Keys, locking & access",
    area: "usability_controls",
    vfc: /vehicle key|digital key|display key|comfort access|lock \/ unlock|anti-theft|remote engine start \(vehicle key|garage door/i,
    text: words(
      "keys?|key ?fob|fob|digital key|comfort access|unlock\\p{L}*|lock(?:s|ed|ing)?|alarm|garage door|schlüssel",
    ),
  },
  {
    id: "adas",
    label: "Driver assistance",
    area: "driver_assistance",
    vfc: /cruise control|driver assistance|highway assistant|steering and lane|lane departure|lane change|blind spot|collision warning|cross traffic|intersection warning|speed limit|traffic jam|traffic light and sign|fatigue|emergency stop|night vision/i,
    text: words(
      "cruise control|adaptive cruise|acc|lane (?:keep\\p{L}*|assist\\p{L}*|departure|change)|blind spot|driving assist\\p{L}*|highway assist\\p{L}*|collision|hands.?free driving|self.?driving|autopilot|speed limit|assistenz\\p{L}*|tempomat",
    ),
  },
  {
    id: "brakes",
    label: "Brakes & pedals",
    area: "driving_experience",
    vfc: /^braking|parking brake|automatic-hold|pedals/i,
    text: words("brakes?|braking|auto ?hold|pedals?|handbrake|bremse\\p{L}*"),
  },
  {
    id: "parking_cameras",
    label: "Parking & cameras",
    area: "driver_assistance",
    vfc: /park|rear view camera|surround view|side view|all-round view|back-up assistant|drive recorder|interior camera/i,
    text: words(
      "park(?:ing)? (?:assist\\p{L}*|sensors?)|parking|pdc|cameras?|surround view|360|reversing|back.?up|einpark\\p{L}*|kamera\\p{L}*",
    ),
  },
  {
    id: "media_audio",
    label: "Audio & media",
    area: "infotainment_digital",
    vfc: /audio|radio|cd \/ dvd|video|rear seat entertainment/i,
    text: words(
      "rear_seat_entertainment|audio|speakers?|sound system|stereo|radio|music|subwoofer|bass|harman|bowers|podcasts?|lautsprecher|musik",
    ),
  },
  {
    id: "seats",
    label: "Seats",
    area: "comfort",
    vfc: /seat|lumbar|headrest/i,
    text: words(
      "seats?|seating|lumbar|headrests?|head rests?|bolsters?|seat massage|massage|(?:driving|seating) position|sitz\\p{L}*",
    ),
  },
  {
    id: "climate",
    label: "Climate control & heating",
    area: "comfort",
    vfc: /air conditioning|blower|climatization|cooling|auxiliary heater|panel heating/i,
    text: words(
      "a\\/c|ac|air ?con\\p{L}*|climate|hvac|heater|heating|blower|vents?|defrost\\p{L}*|fan|klima\\p{L}*|heizung|lüftung",
    ),
  },
  {
    id: "steering_wheel",
    label: "Steering wheel & controls",
    area: "usability_controls",
    vfc: /steering wheel/i,
    text: words("steering_wheel|paddles?|wheel buttons|lenkrad"),
  },
  {
    id: "infotainment_ui",
    label: "Displays, iDrive & operating concept",
    area: "usability_controls",
    vfc: /touch screen|instrument cluster|head-up|operating concept|controller operation|gesture|touch command|connecteddrive and infotainment|display, time|driver profile|apps \(in-car\)/i,
    text: words(
      "idrive|screens?|displays?|touch ?screens?|infotainment|entertainment system|instruments|controls|hmi|customi[sz]ation|menus?|interface|instrument cluster|hud|head.?up|gestures?|software|operating system|controller|knob|bildschirm|bedienung|menü\\p{L}*|tasten",
    ),
  },
  {
    id: "navigation",
    label: "Navigation & traffic info",
    area: "infotainment_digital",
    vfc: /navigation|map update|poi|traffic information|traffic camera/i,
    text: words("navigation|nav|maps?|route|routing|gps|directions|navi"),
  },
  {
    id: "driving_modes",
    label: "Driving & experience modes",
    area: "driving_experience",
    vfc: /my modes|experience modes/i,
    text: words("sport mode|comfort mode|eco ?pro|eco mode|driving modes?|my modes|fahrmodus"),
  },
  {
    id: "exterior_lighting",
    label: "Exterior lighting",
    area: "exterior_design",
    vfc: /exterior lighting|fog light|high-beam|light switch|flashing|welcome light/i,
    text: words(
      "headlights?|head lights?|tail ?lights?|fog lights?|high beams?|turn signals?|indicators?|blinkers?|scheinwerfer",
    ),
  },
  {
    id: "exterior_body",
    label: "Exterior & body",
    area: "exterior_design",
    vfc: /exterior|bumper|hood|radiator grille|side sill|towing|trailer|horn|fuel filler/i,
    text: words(
      "exterior|paint|bumpers?|grille|kidney|hood|bonnet|side mirrors?|mirrors?|body ?work|tow\\p{L}*|trailer|horn|niere|außen\\p{L}*",
    ),
  },
  {
    id: "powertrain",
    label: "Engine, transmission & powertrain",
    area: "driving_experience",
    vfc: /drivetrain|transmission|selector lever|shift paddle|launch control|engine|exhaust|fuel tank|drive readiness/i,
    text: words(
      "engine|motor|power and pickup|passing|transmission|gearbox|gears?|shift\\p{L}*|accelerat\\p{L}*|horsepower|hp|torque|turbo|exhaust|start.?stop|mpg|fuel|petrol|diesel|hybrid|powertrain|getriebe|verbrauch",
    ),
  },
  {
    id: "chassis_handling",
    label: "Handling, ride & chassis",
    area: "driving_experience",
    vfc: /driving dynamics|handling|cushioning|self-leveling|ground clearance|^steering$|dynamic stability/i,
    text: words(
      "handling|handles|ride|rides|ride_quality|suspension|steering|cornering|road ?holding|maneuverab\\p{L}*|manoeuvrab\\p{L}*|ground clearance|turning radius|off.?road|bumps?|potholes?|agile|driving dynamics|drives|fahrwerk|federung|lenkung",
    ),
  },
  {
    id: "wheels_tires",
    label: "Wheels & tires",
    area: "driving_experience",
    vfc: /wheels|tire|tirefit/i,
    text: words("tires?|tyres?|wheels?|rims?|flat tire|tpms|tire pressure|reifen|felgen?"),
  },
  {
    id: "trunk_storage",
    label: "Trunk & storage",
    area: "space_practicality",
    vfc: /luggage|trunk|frunk|through-loading|storage compartment|glove box|cupholder|center armrest/i,
    text: words(
      "trunk|boot|cargo|luggage|tailgate|liftgate|storage|cup ?holders?|glove ?box|cubby|armrests?|frunk|kofferraum|ablage\\p{L}*|stauraum",
    ),
  },
  {
    id: "rear_space",
    label: "Cabin & rear space",
    area: "space_practicality",
    vfc: /space \/ spatial/i,
    text: words("legroom|headroom|rear space|back ?seat room|im fond|beinfreiheit|platz"),
  },
  {
    id: "doors_windows",
    label: "Doors & side windows",
    area: "usability_controls",
    vfc: /door|side window|access and exit|running board|grab handle|resting state/i,
    text: words("doors?|windows?|soft.?close|door handles?|entry|exit|türen?|fenster"),
  },
  {
    id: "glass_roof_wipers",
    label: "Roof, glass & wipers",
    area: "comfort",
    vfc: /panorama|roof|windshield|wiper|rain sensor|wash|heated rear window|sun protection|sun visor|convertible/i,
    text: words(
      "sunroof|moonroof|panoram\\p{L}*|roof|windshield|windscreen|wipers?|sunshades?|sun ?visors?|sun ?blinds?|schiebedach|scheibenwischer",
    ),
  },
  {
    id: "nvh_quietness",
    label: "Cabin quietness",
    area: "comfort",
    vfc: /interior acoustics/i,
    text: words("quiet\\p{L}*|road noise|wind noise|cabin noise|tire noise|insulat\\p{L}*|leise"),
  },
  {
    id: "interior",
    label: "Interior, trim & ambience",
    area: "interior_quality",
    vfc: /interior|upholstery|instrument panel|center console|floor mat|ambient light|rearview mirror/i,
    text: words(
      "interior|instrument panel|cabin|dashboard|dash|trim|plastics?|leather|upholstery|console|ambient|headliner|carpets?|floor mats?|materials?|innenraum|kunststoff|plastik|leder|armaturenbrett",
    ),
  },
  {
    id: "electrical",
    label: "12 V battery & electrical",
    area: "interior_quality",
    vfc: /vehicle battery|12 v/i,
    text: words(
      "12v|12 v|electrical|battery drain\\p{L}*|dead battery|battery died|jump start\\p{L}*",
    ),
  },
  {
    id: "ownership_service",
    label: "Manual, dealer & ownership",
    area: null,
    outOfScope: "Dealer, manual and service topics are not vehicle requirements.",
    vfc: /owner's manual|general enquiry|accessories/i,
    text: words(
      "dealers?|dealership|service (?:center|advisor|appointment)|owner'?s manual|user manual|warranty|recall|werkstatt|händler",
    ),
  },
  // Catch-all last: praise or criticism of the car as a whole.
  {
    id: "vehicle_general",
    label: "Vehicle overall",
    area: null,
    vfc: /overall technology|^body equipment/i,
  },
];

export const ASPECTS: AspectRule[] = [
  {
    id: "noise",
    label: "Noise, squeaks & rattles",
    topic: "noise, squeaks or rattles",
    action: "eliminate squeaks, rattles and unwanted noise",
    kano: "basic",
    area: "comfort",
    vfc: /noise|vibration|like: sound|customer request: sound/i,
    text: words(
      "squeak\\p{L}*|creak\\p{L}*|rattl\\p{L}*|buzz\\p{L}*|noises?|noisy|loud|hum\\p{L}*|whin\\p{L}*|vibrat\\p{L}*|clunk\\p{L}*|knock\\p{L}*|quiet\\p{L}*|sounds?|quietsch\\p{L}*|klapper\\p{L}*|geräusch\\p{L}*|laut",
    ),
  },
  {
    id: "reliability",
    label: "Defects & reliability",
    topic: "defects and failures",
    action: "make it work reliably every time",
    kano: "basic",
    area: "interior_quality",
    vfc: /malfunction|fault|blank|frozen|battery discharge|warning \/ notification|opening, closing: not possible|reception quality|accidental triggering|excessive opening/i,
    text: words(
      "does not work|did not work|do not work|wo not|will not|stopped working|not working|fail\\p{L}*|broke|broken|malfunction\\p{L}*|errors?|glitch\\p{L}*|bugs?|buggy|crash\\p{L}*|freez\\p{L}*|frozen|reset\\p{L}*|disconnect\\p{L}*|intermittent\\p{L}*|faulty|faults?|defect\\p{L}*|unreliable|reliab\\p{L}*|funktioniert nicht|defekt\\p{L}*|ausfall\\p{L}*",
    ),
  },
  {
    id: "usability",
    label: "Ease of use",
    topic: "how hard it is to use",
    action: "make it easier and quicker to use",
    kano: "performance",
    area: "usability_controls",
    vfc: /not user-friendly|size not user friendly|installation and set-up|operating force|stiff movement|like: usability|customer request: usability|like: responsiveness|switch off not possible|permanent switch-off/i,
    text: words(
      "confus\\p{L}*|complicated|difficult|hard to|not intuitive|unintuitive|intuitive|figure out|distract\\p{L}*|cumbersome|awkward|intuitiveness|placement|eas(?:y|e) (?:to|of) (?:use|read|operate|entry|load\\p{L}*)|user.?friendly|too many (?:menus|steps|clicks)|kompliziert|umständlich|bedienbar\\p{L}*",
    ),
  },
  {
    id: "information",
    label: "Information & accuracy",
    topic: "inaccurate or missing information",
    action: "show accurate, trustworthy information",
    kano: "basic",
    area: "infotainment_digital",
    vfc: /information \/ accuracy/i,
    text: words("inaccurate|accuracy|accurate|estimates?|incorrect|misleading|ungenau"),
  },
  {
    id: "comfort",
    label: "Comfort & ergonomics",
    topic: "comfort and ergonomics",
    action: "improve comfort and ergonomics",
    kano: "performance",
    area: "comfort",
    vfc: /comfort|ergonomics/i,
    text: words(
      "comfort\\p{L}*|uncomfortable|ergonom\\p{L}*|ride_quality|(?:driving|seating) position|back pain|posture|supportive|lumbar support|back support|cushion\\p{L}*|firm|soft|bequem\\p{L}*|unbequem|komfort\\p{L}*",
    ),
  },
  {
    id: "performance",
    label: "Performance & response",
    topic: "performance and response",
    action: "improve response and performance",
    kano: "performance",
    area: "driving_experience",
    vfc: /performance|power not ok|response characteristics|too slow|shift characteristics|drivability|pulls to one side|light intensity/i,
    text: words(
      "performance|powerful|acceleration|accelerat\\p{L}*|fast|quick\\p{L}*|sluggish|slow|responsive\\p{L}*|lag\\p{L}*|delay\\p{L}*|jerk\\p{L}*|smooth\\p{L}*|sporty|sportiness|pickup|passing|träge|langsam",
    ),
  },
  {
    id: "efficiency_range",
    label: "Efficiency & range",
    topic: "efficiency and range",
    action: "improve real-world efficiency and range",
    kano: "performance",
    area: "range_charging",
    vfc: /efficiency|range|consumption|charging infrastructure|capacity loss/i,
    text: words("range|efficien\\p{L}*|consumption|mpg|mileage|economy|kwh|reichweite|verbrauch"),
  },
  {
    id: "design",
    label: "Design & looks",
    topic: "the design",
    action: "refine the design customers object to",
    kano: "performance",
    area: "exterior_design",
    vfc: /design|look/i,
    text: words(
      "design\\p{L}*|looks?|looking|beautiful|ugly|styling|style|aesthetic\\p{L}*|colou?rs?|gorgeous|sleek|protzig|hässlich",
    ),
  },
  {
    id: "quality",
    label: "Build quality & materials",
    topic: "build and material quality",
    action: "raise perceived build and material quality",
    kano: "basic",
    area: "interior_quality",
    vfc: /workmanship|fitting fault|damage|dirty|cavity sealant|material quality|leak|condensation|odor|installation: fault/i,
    text: words(
      "quality|cheap\\p{L}*|scratch\\p{L}*|dents?|crack\\p{L}*|peel\\p{L}*|wear|worn|fit and finish|gaps?|leak\\p{L}*|water|smell\\p{L}*|odou?r|rust\\p{L}*|flimsy|well built|craftsmanship|construction|billig|qualität|verarbeitung",
    ),
  },
  {
    id: "space",
    label: "Space, size & storage",
    topic: "space and storage",
    action: "add usable space and storage",
    kano: "performance",
    area: "space_practicality",
    vfc: /storage space|space|size|too few/i,
    text: words(
      "space|spacious|room|roomy|roominess|cramped|legroom|headroom|capacity|small|tight|big|large|eng|platz",
    ),
  },
  {
    id: "visibility",
    label: "Visibility & view",
    topic: "visibility",
    action: "improve visibility",
    kano: "basic",
    area: "comfort",
    vfc: /view/i,
    text: words("visibility|see out|sightlines?|view|sicht"),
  },
  {
    id: "value_price",
    label: "Price & value",
    topic: "price and value for money",
    action: "review price and value",
    kano: "indifferent",
    area: "variants_packages",
    outOfScope: PRICING,
    vfc: /price-performance|not standard \/ too costly/i,
    text: words(
      "price\\p{L}*|expensive|costs?|costly|value|money|worth|overpriced|pay|afford\\p{L}*|preis\\p{L}*|teuer",
    ),
  },
  {
    id: "features",
    label: "Features & functions",
    topic: "missing or limited functions",
    action: "add the functions customers ask for",
    kano: "delighter",
    area: "variants_packages",
    vfc: /function|equipment|compatibility/i,
    text: words(
      "features?|functions?|functionality|options?|equipment|funktion\\p{L}*|ausstattung",
    ),
  },
];

/** Used when nothing more specific is known, and for BMW's generic "Like: function" praise. */
export const GENERAL_ASPECT: AspectRule = {
  id: "general",
  label: "Overall",
  topic: "it overall",
  action: "address the recurring feedback",
  kano: "performance",
  area: "driving_experience",
};
export const GENERAL_VFC = /^like: function$/i;

/** Cues for comments without a BMW feedback type. A request cue wins over sentiment. */
export const REQUEST_CUES =
  /(?<![\p{L}])(?:wish\p{L}*|would (?:like|love|be (?:nice|great|good|better))|should (?:have|be|offer|add)|could (?:have|use|be)|needs? (?:to|a|an)|please add|hope\p{L}*|if only|missing|suggest\p{L}*|want(?:ed)? (?:a|an|the|to have)|bring back|wünsch\p{L}*|hätte gern\p{L}*|sollte|fehlt|wäre schön)(?![\p{L}])/giu;
export const NEGATIVE_CUES =
  /(?<![\p{L}])(?:not|never|no longer|problems?|issues?|fail\p{L}*|broke\p{L}*|annoy\p{L}*|hate\p{L}*|terrible|awful|poor\p{L}*|bad|worse|worst|disappoint\p{L}*|uncomfortable|squeak\p{L}*|creak\p{L}*|rattl\p{L}*|noisy|difficult|hard to|confus\p{L}*|complain\p{L}*|frustrat\p{L}*|lack\p{L}*|too (?:loud|small|hard|stiff|slow|expensive|sensitive|eng)|unreliable|cheap|nicht|kein\p{L}*|schlecht\p{L}*|billig|zu eng|zu laut|protzig|quietsch\p{L}*|klapper\p{L}*)(?![\p{L}])/giu;
export const POSITIVE_CUES =
  /(?<![\p{L}])(?:love\p{L}*|great|excellent|amazing|fantastic|awesome|good|nice|(?:i|we|they|she|he|customer|really|also) (?:like|likes|liked)|enjoy\p{L}*|comfortable|smooth|impressive|best|perfect\p{L}*|happy|pleased|beautiful|wonderful|quiet|toll|super|gefällt|liebe)(?![\p{L}])/giu;

/** Country code → the sales regions BMW reports in (EU = the Europe region incl. GB, NO, CH). */
const EUROPE = new Set(
  "AT BE BG CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LT LU LV MT NL NO PL PT RO SE SI SK".split(
    " ",
  ),
);
export function regionOf(market: string | undefined): string {
  const m = (market ?? "").toUpperCase();
  if (!m) return "unknown";
  if (m === "EU" || m === "US" || m === "CN") return m;
  if (EUROPE.has(m)) return "EU";
  return "RoW";
}
