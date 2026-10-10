export type PowertrainType = "electric" | "hybrid" | "h2" | "gasoline";

export type BodyType =
  | "sedan"
  | "coupe"
  | "touring"
  | "suv"
  | "convertible"
  | "gran_coupe"
  | "race"
  | "concept"
  | "roadster"
  | "hatchback";

export type CarSpecialPart =
  | "rear_spoiler"
  | "duckbill_spoiler"
  | "gt_wing"
  | "front_splitter"
  | "canards"
  | "widebody_flares"
  | "rear_diffuser"
  | "roll_cage"
  | "roof_rails"
  | "skid_plates"
  | "convertible_roof"
  | "hood_vents"
  | "exhaust_system"
  | "fuel_system"
  | "h2_storage"
  | "combustion_engine"
  | "fuel_cell";

export interface VehicleDimensions {
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  frontAxleX: number;
  rearAxleX: number;
  track: number;
  tyreRadius: number;
  tyreWidth: number;
  groundClearance: number;
}

export interface VehicleModel {
  id: string;
  name: string;
  sketchfabUid: string;
  year: number;
  series: string;
  chassisCode: string;
  bodyType: BodyType;
  defaultPowertrain: PowertrainType;
  supportedPowertrains: PowertrainType[];
  dimensions: VehicleDimensions;
  specialParts: CarSpecialPart[];
  description: string;
}
