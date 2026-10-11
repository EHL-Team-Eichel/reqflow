import { describe, expect, it } from "vitest";
import {
  countryColumnScore,
  countryName,
  countryRecognitionRate,
  countryRegion,
  normalizeCountry,
} from "./countries";

describe("normalizeCountry", () => {
  it("recognises ISO alpha-2 and alpha-3 codes in any case", () => {
    expect(normalizeCountry("DE")).toEqual({ code: "DE", name: "Germany", region: "Europe" });
    expect(normalizeCountry("de")?.code).toBe("DE");
    expect(normalizeCountry("DEU")?.code).toBe("DE");
    expect(normalizeCountry("usa")?.code).toBe("US");
    expect(normalizeCountry("CN")).toEqual({ code: "CN", name: "China", region: "China" });
  });

  it("recognises English and German names, ignoring case, diacritics, dots and spacing", () => {
    expect(normalizeCountry("Germany")?.code).toBe("DE");
    expect(normalizeCountry("Deutschland")?.code).toBe("DE");
    expect(normalizeCountry("  south   korea ")?.code).toBe("KR");
    expect(normalizeCountry("Südkorea")?.code).toBe("KR");
    expect(normalizeCountry("Österreich")?.code).toBe("AT");
    expect(normalizeCountry("Curaçao")?.code).toBe("CW");
    expect(normalizeCountry("Curacao")?.code).toBe("CW");
    expect(normalizeCountry("Côte d'Ivoire")?.code).toBe("CI");
    expect(normalizeCountry("Côte d’Ivoire")?.code).toBe("CI");
    expect(normalizeCountry("Großbritannien")?.code).toBe("GB");
  });

  it("maps the common aliases to their ISO code", () => {
    const aliases: [string, string][] = [
      ["UK", "GB"],
      ["Great Britain", "GB"],
      ["England", "GB"],
      ["USA", "US"],
      ["U.S.", "US"],
      ["United States of America", "US"],
      ["EL", "GR"],
      ["Holland", "NL"],
      ["PRC", "CN"],
      ["Mainland China", "CN"],
      ["Korea", "KR"],
      ["Czechia", "CZ"],
      ["Tschechien", "CZ"],
      ["Schweiz", "CH"],
      ["Oesterreich", "AT"],
      ["Turkey", "TR"],
      ["Türkei", "TR"],
      ["Vietnam", "VN"],
      ["Viet Nam", "VN"],
    ];
    for (const [input, code] of aliases) {
      expect(normalizeCountry(input)?.code, input).toBe(code);
    }
  });

  it("returns null for empty, non-string and non-country values", () => {
    const rejected: unknown[] = [
      "",
      "   ",
      "EU",
      "EMEA",
      "APAC",
      "World",
      "Europe",
      "Other",
      "Atlantis",
      49,
      null,
      undefined,
      ["DE"],
      {},
    ];
    for (const value of rejected) {
      expect(normalizeCountry(value), String(value)).toBeNull();
    }
  });
});

describe("countryName and countryRegion", () => {
  it("gives the English name for known codes, case-insensitively", () => {
    expect(countryName("GB")).toBe("United Kingdom");
    expect(countryName("kr")).toBe("South Korea");
    expect(countryName("CZ")).toBe("Czechia");
    expect(countryName("RU")).toBe("Russia");
    expect(countryName("TW")).toBe("Taiwan");
    expect(countryName("US")).toBe("United States");
  });

  it("returns unknown codes unchanged", () => {
    expect(countryName("XX")).toBe("XX");
    expect(countryName("EU")).toBe("EU");
  });

  it("assigns regions as the rules describe", () => {
    expect(countryRegion("CN")).toBe("China");
    expect(countryRegion("US")).toBe("North America");
    expect(countryRegion("CA")).toBe("North America");
    expect(countryRegion("MX")).toBe("North America");
    expect(countryRegion("GB")).toBe("Europe");
    expect(countryRegion("CH")).toBe("Europe");
    expect(countryRegion("RS")).toBe("Europe");
    expect(countryRegion("TR")).toBe("Europe");
    for (const code of [
      "JP",
      "KR",
      "AU",
      "NZ",
      "IN",
      "SG",
      "TW",
      "HK",
      "TH",
      "MY",
      "ID",
      "PH",
      "VN",
    ]) {
      expect(countryRegion(code), code).toBe("Asia-Pacific");
    }
    for (const code of ["AE", "IL", "ZA", "EG", "MA"]) {
      expect(countryRegion(code), code).toBe("Middle East & Africa");
    }
    for (const code of ["BR", "AR", "CL", "CO", "PE"]) {
      expect(countryRegion(code), code).toBe("Latin America");
    }
    expect(countryRegion("XX")).toBe("Other");
  });
});

describe("countryRecognitionRate", () => {
  it("is the share of non-empty values that are countries", () => {
    expect(countryRecognitionRate(["DE", "Germany", "Atlantis", "", null, "France"])).toBeCloseTo(
      3 / 4,
    );
  });

  it("counts each entry of a list value", () => {
    expect(countryRecognitionRate([["DE", "Mars"], "FR"])).toBeCloseTo(2 / 3);
  });

  it("gives 0 for empty input and for values that are not strings", () => {
    expect(countryRecognitionRate([])).toBe(0);
    expect(countryRecognitionRate(["", "  ", null, undefined])).toBe(0);
    expect(countryRecognitionRate([49, { country: "DE" }])).toBe(0);
  });
});

describe("countryColumnScore", () => {
  it("scores exact synonyms 1, ignoring case, spaces, underscores and dashes", () => {
    const exact = [
      "Country",
      "country_code",
      "Country Code",
      "ISO-Code",
      "iso",
      "Market",
      "Markt",
      "Land",
      "Nation",
      "Country Name",
      "Ländercode",
      "Laendercode",
    ];
    for (const header of exact) {
      expect(countryColumnScore(header), header).toBe(1);
    }
  });

  it("scores 0.5 when country or land is a word part of the header", () => {
    expect(countryColumnScore("Country of origin")).toBe(0.5);
    expect(countryColumnScore("Countries")).toBe(0.5);
    expect(countryColumnScore("Herkunftsland")).toBe(0.5);
    expect(countryColumnScore("Land / Region")).toBe(0.5);
  });

  it("scores 0 for other headers, including region columns and Island", () => {
    for (const header of ["Region", "Sales region", "Island", "Revenue", "Date", "", "Feedback"]) {
      expect(countryColumnScore(header), header).toBe(0);
    }
  });
});
