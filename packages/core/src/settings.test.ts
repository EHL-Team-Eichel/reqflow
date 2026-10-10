import { describe, expect, it } from "vitest";
import { CarPowertrain, DEFAULT_SETTINGS, Settings } from "./settings";

describe("car model settings", () => {
  it.each(CarPowertrain.options)("accepts the %s model", (powertrain) => {
    expect(Settings.parse({ ...DEFAULT_SETTINGS, model: { powertrain } }).model.powertrain).toBe(
      powertrain,
    );
  });

  it("defaults older settings to the original electric sketch without changing scope", () => {
    const { model: _model, ...older } = DEFAULT_SETTINGS;
    const settings = Settings.parse(older);
    expect(settings.model).toEqual({ powertrain: "electric" });
    expect(settings.defaultScope).toEqual(older.defaultScope);
  });

  it("rejects unknown and malformed models", () => {
    for (const model of [{ powertrain: "diesel" }, {}, null, "electric"])
      expect(Settings.safeParse({ ...DEFAULT_SETTINGS, model }).success).toBe(false);
  });
});
