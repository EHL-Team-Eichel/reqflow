// SYNTHETIC sample data for the Raw block — invented for development, NOT BMW data, NOT real quotes.
// Regenerate with: node data/samples/generate.ts   (Node ≥ 23.6 runs TypeScript directly)
//
// The files imitate formats a BMW export might have, including the awkward parts the parser must
// handle: a UTF-8 BOM, quoted comments with commas and line breaks, a German Excel CSV (semicolons,
// decimal commas, Windows-1252), and a workbook with two sheets.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import writeXlsxFile from "write-excel-file/node";

const here = dirname(fileURLToPath(import.meta.url));
const csvCell = (v: string | number, delimiter: string) => {
  const s = String(v);
  return s.includes(delimiter) || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: (string | number)[][], delimiter = ",") =>
  rows.map((r) => r.map((c) => csvCell(c, delimiter)).join(delimiter)).join("\r\n") + "\r\n";

// 1. Customer feedback — UTF-8 with BOM, comma-separated, free text in four languages.
const feedback: [string, string, string, string, number, string, string][] = [
  ["2026-03-02", "DE", "Sedan", "dealer survey", 2, "de", "Im Fond ist die Beinfreiheit für Erwachsene zu knapp, auf langen Fahrten unbequem."],
  ["2026-03-04", "DE", "Sedan", "app review", 2, "de", "Das Infotainment hat zu viele Untermenüs, die Klimaanlage per Touch zu bedienen nervt während der Fahrt."],
  ["2026-03-05", "FR", "Sedan", "dealer survey", 3, "fr", "La recharge rapide est correcte, mais l'autonomie annoncée n'est jamais atteinte sur autoroute en hiver."],
  ["2026-03-07", "IT", "Sedan", "call center", 4, "it", "Sedili anteriori molto comodi, però il bagagliaio è troppo piccolo per le valigie di una famiglia."],
  ["2026-03-08", "GB", "Sedan", "dealer survey", 2, "en", "Rear legroom is too tight for adults; my teenagers complain on every longer trip."],
  ["2026-03-09", "GB", "Sedan", "app review", 1, "en", "The digital key stopped working twice after a phone update, which left me standing at the car."],
  ["2026-03-11", "DE", "Touring", "dealer survey", 5, "de", "Fahrgefühl ist hervorragend, die Lenkung präzise. Genau deshalb fahre ich BMW."],
  ["2026-03-12", "NL", "Sedan", "app review", 3, "en", "Voice assistant understands navigation commands, but not \"make it warmer\", which is what I actually say."],
  ["2026-03-14", "DE", "Sedan", "call center", 2, "de", "Wind- und Abrollgeräusche ab 130 km/h sind lauter als bei meinem vorherigen Fahrzeug."],
  ["2026-03-15", "FR", "Sedan", "dealer survey", 4, "fr", "L'éclairage d'ambiance est superbe, l'intérieur fait vraiment premium."],
  ["2026-03-16", "IT", "Sedan", "app review", 2, "it", "Il sistema di parcheggio automatico è troppo lento e si interrompe spesso."],
  ["2026-03-18", "GB", "Sedan", "dealer survey", 3, "en", "Wireless charging pad overheats the phone, so I stopped using it, which is a shame."],
  ["2026-03-19", "DE", "Sedan", "dealer survey", 2, "de", "Zu wenig Ablagen in der Mittelkonsole, wohin mit Handy, Schlüssel und Sonnenbrille?"],
  ["2026-03-21", "ES", "Sedan", "call center", 3, "es", "La pantalla es muy grande pero los menús son demasiado complicados para usar mientras conduces."],
  ["2026-03-22", "DE", "Sedan", "app review", 4, "de", "Die App zeigt den Ladestand zuverlässig, Vorklimatisieren im Winter ist ein echter Mehrwert."],
  ["2026-03-24", "GB", "Sedan", "dealer survey", 2, "en", "Charging on public chargers is unpredictable, the car doesn't tell me which ones actually work."],
  ["2026-03-25", "FR", "Touring", "dealer survey", 5, "fr", "Le Touring est parfait pour la famille, coffre immense et attelage très pratique."],
  ["2026-03-27", "DE", "Sedan", "call center", 2, "de", "Kopffreiheit hinten ist für Personen über 1,85 m nicht ausreichend."],
  ["2026-03-28", "IT", "Sedan", "dealer survey", 3, "it", "Mi piacerebbe un sedile posteriore riscaldato di serie, d'inverno i bambini hanno freddo."],
  ["2026-03-30", "GB", "Sedan", "app review", 2, "en", "Lane keeping assistant is too nervous on narrow country roads, I switch it off every time."],
  ["2026-04-01", "DE", "Sedan", "dealer survey", 3, "de", "Ein Head-up-Display sollte in dieser Klasse Serie sein, nicht Teil eines teuren Pakets."],
  ["2026-04-02", "NL", "Sedan", "dealer survey", 4, "en", "Seats are excellent on long drives, no back pain even after 600 km."],
  ["2026-04-04", "FR", "Sedan", "app review", 2, "fr", "Les mises à jour à distance prennent trop de temps et la voiture est inutilisable pendant ce temps."],
  ["2026-04-05", "DE", "Sedan", "call center", 1, "de", "Das Kofferraumvolumen der Limousine reicht nicht für einen Kinderwagen plus Gepäck."],
  ["2026-04-07", "GB", "Sedan", "dealer survey", 3, "en", "Competitor models offer massage seats in the rear, which my chauffeur clients ask for."],
  ["2026-04-08", "IT", "Sedan", "dealer survey", 4, "it", "Il suono dell'impianto audio è eccellente, ma il controllo del volume al volante è scomodo."],
  ["2026-04-10", "DE", "Sedan", "app review", 2, "de", "Die Sprachsteuerung versteht keine Dialekte und schaltet oft das falsche Radio ein."],
  ["2026-04-11", "ES", "Sedan", "dealer survey", 3, "es", "El aire acondicionado trasero no es suficiente en verano, los pasajeros pasan calor."],
  ["2026-04-13", "GB", "Sedan", "call center", 2, "en", "Getting in and out of the back is awkward, the door opening is too small for older passengers."],
  ["2026-04-14", "DE", "Sedan", "dealer survey", 4, "de", "Laserlicht ist beeindruckend, nachts fühle ich mich deutlich sicherer."],
  ["2026-04-16", "FR", "Sedan", "dealer survey", 2, "fr", "Trop de fonctions sont devenues des abonnements, je préfère payer une fois.\nC'est frustrant."],
  ["2026-04-17", "DE", "Sedan", "app review", 3, "de", "Die Reichweitenanzeige springt bei Kälte stark, ich kann der Prognose nicht vertrauen."],
  ["2026-04-19", "GB", "Sedan", "dealer survey", 5, "en", "Best driving dynamics in the segment, the car feels lighter than it is."],
  ["2026-04-20", "IT", "Sedan", "call center", 2, "it", "Il portellone del bagagliaio non è elettrico di serie, nella mia auto precedente lo era."],
  ["2026-04-22", "DE", "Sedan", "dealer survey", 3, "de", ""], // no comment: the parser must skip and report it
  ["2026-04-23", "NL", "Sedan", "app review", 2, "en", "Phone mirroring disconnects in tunnels and takes ages to reconnect."],
];
const feedbackRows = [
  ["feedback_id", "date", "market", "model", "derivative", "channel", "rating", "language", "comment"],
  ...feedback.map(([date, market, derivative, channel, rating, language, comment], i) => [
    `FB-${String(i + 1).padStart(4, "0")}`, date, market, "5 Series", derivative, channel, rating, language, comment,
  ]),
];
writeFileSync(join(here, "customer_feedback.csv"), "﻿" + toCsv(feedbackRows), "utf8");

// 2. Equipment take rates — German Excel CSV: semicolons, decimal commas, Windows-1252 (umlauts).
const equipment: [string, string, string, string, string][] = [
  ["S494A", "Sitzheizung vorn", "Komfort", "86,4", "EU"],
  ["S4NMA", "Sitzheizung hinten", "Komfort", "23,8", "EU"],
  ["S6U3A", "Head-up-Display", "Infotainment", "41,2", "EU"],
  ["S5ASA", "Driving Assistant Professional", "Fahrerassistenz", "38,5", "EU"],
  ["S5DNA", "Parking Assistant Plus", "Fahrerassistenz", "72,9", "EU"],
  ["S688A", "Harman Kardon Surround Sound System", "Infotainment", "47,0", "EU"],
  ["S6NWA", "Wireless Charging", "Infotainment", "91,3", "EU"],
  ["S3DFA", "Anhängerkupplung", "Raum", "34,1", "EU"],
  ["S4NBA", "Klimaautomatik 4-Zonen", "Komfort", "12,6", "EU"],
  ["S322A", "Komfortzugang", "Bedienung", "79,8", "EU"],
  ["S4FLA", "Ambientes Licht", "Interieur", "68,2", "EU"],
  ["S5ATA", "Rear Seat Entertainment", "Infotainment", "4,9", "EU"],
  ["S7LFA", "M Sportpaket", "Pakete", "62,7", "EU"],
  ["S2VRA", "Adaptives Fahrwerk", "Fahrdynamik", "18,4", "EU"],
  ["S4U9A", "Massagefunktion vorn", "Komfort", "9,7", "EU"],
  ["S6WDA", "Laserlicht", "Exterieur", "15,0", "EU"],
  ["S316A", "Automatische Heckklappenbetätigung", "Komfort", "", "EU"], // missing rate: must be reported
];
const equipmentRows = [
  ["Markt", "Modell", "Derivat", "Modelljahr", "SA-Code", "Ausstattung", "Kategorie", "Einbaurate %"],
  ...equipment.map(([code, name, cat, rate, market]) => [market, "5 Series", "Sedan", 2026, code, name, cat, rate]),
];
writeFileSync(join(here, "equipment_take_rates.csv"), Buffer.from(toCsv(equipmentRows, ";"), "latin1"));

// 3. Sales volumes — comma CSV, one row per derivative and year.
const volumes: [string, string, number[]][] = [
  ["EU", "Sedan", [41200, 39800, 37100]],
  ["EU", "Touring", [28900, 31800, 35200]],
  ["EU", "i5 Sedan", [6100, 9800, 14600]],
  ["EU", "i5 Touring", [0, 3200, 7900]],
];
const salesRows = [
  ["market", "model", "derivative", "year", "units"],
  ...volumes.flatMap(([market, derivative, units]) =>
    units.map((u, i) => [market, "5 Series", derivative, 2023 + i, u]),
  ),
];
writeFileSync(join(here, "sales_volumes.csv"), toCsv(salesRows), "utf8");

// 4. Customer study — an Excel workbook with a results sheet and a verbatims sheet.
const results = [
  ["question_id", "question", "segment", "respondents", "mean_score", "top2box_pct"],
  ["Q01", "Satisfaction with rear seat space", "Families", 412, 2.9, 31],
  ["Q02", "Satisfaction with infotainment ease of use", "All", 1204, 3.1, 38],
  ["Q03", "Satisfaction with driving dynamics", "All", 1204, 4.5, 89],
  ["Q04", "Trust in the range prediction (BEV)", "BEV owners", 286, 2.7, 27],
  ["Q05", "Importance of a digital key", "Under 40", 351, 3.9, 64],
  ["Q06", "Satisfaction with boot space", "Families", 412, 3.0, 35],
  ["Q07", "Satisfaction with seat comfort on long trips", "All", 1204, 4.3, 82],
];
const verbatims = [
  ["respondent_id", "segment", "language", "verbatim"],
  ["R-0012", "Families", "en", "With two child seats in the back there is no room left for a third passenger."],
  ["R-0047", "BEV owners", "de", "Im Winter verliere ich gefühlt ein Drittel der Reichweite, das macht Langstrecken stressig."],
  ["R-0103", "Under 40", "en", "I would pay for features once, but not as monthly subscriptions."],
  ["R-0158", "All", "fr", "Le système multimédia devrait être aussi simple qu'un smartphone."],
  ["R-0201", "Families", "it", "Il bagagliaio della berlina è piccolo rispetto alla concorrenza."],
  ["R-0244", "All", "de", "Das Fahrwerk ist sportlich und trotzdem komfortabel, ein echtes Highlight."],
];
await writeXlsxFile([
  { sheet: "Results", data: results },
  { sheet: "Verbatims", data: verbatims },
]).toFile(join(here, "customer_study.xlsx"));

console.log("Wrote 4 synthetic sample files to", here);
