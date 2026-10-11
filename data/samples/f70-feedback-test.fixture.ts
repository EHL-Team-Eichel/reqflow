// Entirely invented feedback and classification labels, NOT BMW data or its taxonomy.
export const feedbackSheet = "Feedback_Explorer";
export const feedbackHeader = [
  "ID", "Source", "Brand", "Sales Description", "Country", "Derivate (e-code)",
  "Engine Type", "Feedback Type", "Customer Feedback", "Vfc level2 3 Name",
  "Vfc level2 Name", "Vfc level3 Name",
];

export const feedbackTopics = [
  { key: "infotainment", comments: [
    "The navigation screen fails every trip and needs a restart before I can select a destination.",
    "CarPlay disconnects daily and I cannot use navigation until I reconnect my phone.",
    "The infotainment screen is poor at startup and fails to show navigation on every trip.",
    "Navigation fails daily when I zoom the map and needs a restart.",
    "The screen is unusable after startup until I restart it on every trip.",
    "CarPlay fails to reconnect daily after a short stop.",
    "The navigation screen is frustrating because it freezes every trip.",
    "Bluetooth fails daily and I cannot use phone calls reliably.",
    "Android Auto fails every trip and needs a restart to reconnect.",
    "The infotainment screen cannot show my saved destination after it fails daily.",
    "Navigation is unusable every trip when the screen stays black.",
    "CarPlay is frustrating because it fails daily halfway through a journey.",
    "The screen fails every trip when I switch between navigation and CarPlay.",
    "Bluetooth is broken daily until I restart the infotainment system.",
    "Navigation fails daily and I need a restart to recover the map.",
    "The screen is poor because navigation fails every trip after a short stop.",
    "CarPlay is unusable daily until I restart the connection.",
    "I love the navigation screen and CarPlay works well on my journeys.",
  ] },
  { key: "physical-controls", comments: [
    "I need a physical button for demisting because searching for it is difficult every trip.",
    "The button labels are poor and difficult to read every day.",
    "I want a tactile knob because the flat controls are frustrating on every trip.",
    "The controls are difficult to locate by feel every trip.",
    "A dedicated button is missing and this is frustrating daily.",
    "The knob is too small and difficult to grip every day.",
    "I need distinct button shapes because the controls are difficult to distinguish every trip.",
    "The switches are poor to use with gloves and annoy me daily.",
    "I want a direct button instead of complicated controls on every trip.",
    "The controls lack tactile feedback and are difficult to use daily.",
    "The button position is inconvenient and needs improvement every trip.",
    "I need larger button markings because the controls are difficult to read daily.",
    "The knob is frustrating because its response is poor on every trip.",
    "I love the tactile knob and the physical controls work well for me.",
  ] },
  { key: "rear-space", comments: [
    "Rear legroom is poor and my knees hurt on every trip with another adult in front.",
    "There is not enough knee room for adult passengers on daily journeys.",
    "Rear passenger space is poor and I cannot fit behind a tall adult.",
    "I need more rear legroom because my knees hurt every trip.",
    "Rear headroom is poor and I cannot sit upright on daily journeys.",
    "The rear space is too small and difficult for adults to use every trip.",
    "I want more knee room because the cramped rear space is frustrating daily.",
    "Rear legroom is poor and tall passengers cannot use it for longer journeys.",
    "Passenger space in the back is too small and annoys my family every trip.",
    "Rear legroom is too small and I need more knee room every day.",
    "Rear headroom is poor and taller passengers cannot sit upright.",
    "I love the rear legroom and the passenger space is great for my family.",
  ] },
  { key: "front-seating", comments: [
    "The front seat is uncomfortable and my back hurts on every trip longer than an hour.",
    "The front seat cushion is poor and causes pain on daily journeys.",
    "I need better front seat support because my shoulders hurt every trip.",
    "The front seat is uncomfortable and difficult to adjust every day.",
    "The seat backrest is poor and needs better support on every trip.",
    "The front seat is too small and my legs hurt on daily journeys.",
    "I want improved front seat comfort because the cushion is uncomfortable every trip.",
    "The front seat bolsters are uncomfortable and my hips hurt daily.",
    "The front seat support is poor and needs improvement on every trip.",
    "I love the front seat and it is comfortable on long journeys.",
  ] },
  { key: "boot-storage", comments: [
    "The boot is too small and I cannot fit a folded pushchair with two weekend bags.",
    "Boot storage is poor and luggage cannot fit on every family trip.",
    "The trunk opening is too small and I cannot load a folded pushchair.",
    "I need better boot storage because loading family luggage is difficult every trip.",
    "The boot floor is inconvenient and heavy luggage is difficult to lift every day.",
    "Cargo storage is too small and I cannot carry our weekly shopping with a pushchair.",
    "The boot lacks useful storage dividers and bags move around every trip.",
    "The boot opening is difficult and I cannot load a large travel bag.",
    "Luggage storage is poor and the trunk is too small on every trip.",
    "I love the boot storage and the luggage area is great for my family.",
  ] },
  { key: "climate", comments: [
    "The climate system is poor and heating fails daily during cold mornings.",
    "Heating is not working every trip and needs a restart to deliver warm air.",
    "Air conditioning fails daily and I cannot cool the cabin on hot afternoons.",
    "The climate airflow is poor and I need more consistent heating every day.",
    "Ventilation is frustrating because it fails to keep a stable temperature every trip.",
    "I love the climate system and the heating works well in winter.",
  ] },
  { key: "cabin-noise", comments: [
    "Cabin noise is poor and I cannot hear passengers at motorway speed.",
    "Wind noise is annoying every trip on the motorway.",
    "The cabin is noisy and conversations are difficult on daily journeys.",
    "Road noise is frustrating and I need a quieter cabin on every trip.",
    "Cabin noise is poor and tiring on every motorway journey.",
    "I love the quiet cabin and the noise level is fine as is.",
  ] },
  { key: "steering", comments: [
    "Steering is poor around the centre and needs improvement every trip.",
    "The steering response is frustrating on daily journeys through bends.",
    "Handling is poor and I want more predictable steering every day.",
    "Steering is difficult to judge and needs more consistent response every trip.",
    "The steering feels vague and I want clearer feedback on daily journeys.",
    "I love the steering and the handling is excellent on winding roads.",
  ] },
  { key: "material-quality", comments: [
    "Dashboard material quality is poor and the plastic feels cheap every day.",
    "Interior quality is frustrating because the dashboard finish feels poor on every trip.",
    "I want better dashboard materials because the plastic quality is poor daily.",
    "I love the dashboard materials and the interior quality is excellent.",
  ] },
  { key: "exterior-lighting", comments: [
    "The headlights are poor and I cannot see bends clearly on dark roads.",
    "Headlight illumination needs improvement because dark roads are difficult every trip.",
    "The headlights are poor and I want more even illumination on daily journeys.",
    "I love the headlight design and the headlights are great on dark roads.",
  ] },
];

const countries = ["DE", "FR", "IT", "ES", "NL"];
export const feedbackRows: string[][] = [];
export const topicIds: Record<string, string[]> = {};
export const positiveIds: string[] = [];
function add(text: string, topic: string, type = "Complaint"): string {
  const id = `SYN-F70-${String(feedbackRows.length + 1).padStart(3, "0")}`;
  feedbackRows.push([
    id, "SYNTHETIC TEST - NOT BMW DATA", "BMW", "120",
    countries[feedbackRows.length % countries.length]!, "F70", "Petrol", type,
    text, `SYNTHETIC / ${topic}`, "SYNTHETIC customer experience", `SYNTHETIC ${topic}`,
  ]);
  return id;
}
for (const topic of feedbackTopics) {
  topicIds[topic.key] = topic.comments.map((comment, i) => {
    const positive = i === topic.comments.length - 1;
    const id = add(comment, topic.key, positive ? "Praise" : "Complaint");
    if (positive) positiveIds.push(id);
    return id;
  });
}
export const outOfScopeIds = [
  "The price is too high and I want a cheaper vehicle.",
  "The dealer appointment was poor and I want faster service.",
  "The warranty paperwork is frustrating and I need simpler terms.",
  "The ownership cost is too high and I want a discount.",
].map((text) => add(text, "out-of-scope"));

// Same identity/text, another classification: Raw must merge these, not count new opinions.
export const duplicateIds = [feedbackRows[0]![0]!, feedbackRows[18]![0]!];
for (const index of [0, 18]) {
  const row = [...feedbackRows[index]!];
  row[9] = "SYNTHETIC / secondary classification";
  row[11] = "SYNTHETIC alternate classification";
  feedbackRows.push(row);
}
// Same wording, distinct identities: Raw must preserve both as separate feedback entries.
export const independentCopyIds = [
  add(feedbackRows[0]![8]!, "infotainment"),
  add(feedbackRows[32]![8]!, "rear-space"),
];
export const mixedId = add(
  "The navigation screen is great for maps but poor because it fails every trip.",
  "infotainment", "Mixed",
);
export const blankId = add("", "blank-comment");
