import { beforeEach, describe, expect, it, vi } from "vitest";
import { quoteMatch, verifyQuote } from "./web-verify";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
const quote = "The rear seat squeaks over bumps during every journey";
beforeEach(() => {
  vi.restoreAllMocks();
});
describe("web evidence verification", () => {
  it("accepts an exact normalized quote with fake HTTP, not paraphrases", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(`<p>${quote}</p>`));
    expect((await verifyQuote("https://example.com/review", quote)).verified).toBe(true);
    expect(
      (await verifyQuote("https://example.com/review", quote.replace("journey", "trip"))).verified,
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: "error" }),
    );
    expect(quoteMatch(quote, quote)).toBe(1);
  });
  it("refuses private targets and blocked domains before fetching", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect((await verifyQuote("http://127.0.0.1/private", quote)).verified).toBe(false);
    expect(
      (await verifyQuote("https://example.com/review", quote, { blockedDomains: ["example.com"] }))
        .verified,
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
