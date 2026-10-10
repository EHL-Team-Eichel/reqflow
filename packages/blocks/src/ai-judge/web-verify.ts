// Checks that a web quote really appears on the cited page. Unverified items are shown but never scored.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3_000_000;

export function normalizeText(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&#34;|[“”„]/g, '"')
    .replace(/&#39;|&apos;|[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'"%.,-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Share of the quote"s 6-word shingles found in the page (1 = verbatim). */
export function quoteMatch(page: string, quote: string): number {
  const p = normalizeText(page);
  const q = normalizeText(quote);
  if (!q) return 0;
  if (p.includes(q)) return 1;
  const words = q.split(" ");
  if (words.length < 6) return 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 6 <= words.length; i++) {
    total++;
    if (p.includes(words.slice(i, i + 6).join(" "))) hit++;
  }
  return total ? hit / total : 0;
}

export interface Verification {
  verified: boolean;
  reason: string;
}

export async function verifyQuote(
  url: string,
  quote: string,
  options: { signal?: AbortSignal; allowedDomains?: string[]; blockedDomains?: string[] } = {},
): Promise<Verification> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { verified: false, reason: "invalid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { verified: false, reason: "not an http(s) URL" };
  if (normalizeText(quote).split(" ").length < 8)
    return { verified: false, reason: "quote too short to verify" };
  try {
    const domainMatches = (domain: string) =>
      u.hostname === domain || u.hostname.endsWith(`.${domain}`);
    const isPrivate = (ip: string) =>
      isIP(ip) === 6 ||
      /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip);
    if (u.username || u.password || (u.port && u.port !== "80" && u.port !== "443"))
      return { verified: false, reason: "URL credentials or non-standard port refused" };
    if (
      u.hostname === "localhost" ||
      u.hostname.endsWith(".local") ||
      u.hostname.endsWith(".localhost") ||
      isPrivate(u.hostname)
    )
      return { verified: false, reason: "Private-network URLs are refused" };
    if (options.blockedDomains?.some(domainMatches))
      return { verified: false, reason: "Domain is blocked in Settings" };
    if (options.allowedDomains?.length && !options.allowedDomains.some(domainMatches))
      return { verified: false, reason: "Domain is not allowed in Settings" };
    const addresses = await lookup(u.hostname, { all: true });
    if (!addresses.length || addresses.some((a) => isPrivate(a.address)))
      return { verified: false, reason: "Private-network DNS target refused" };
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(u, {
      redirect: "error",
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
      headers: {
        "user-agent": "Mozilla/5.0 (ReqFlow evidence verifier)",
        accept: "text/html,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    if (!res.ok) return { verified: false, reason: `page returned HTTP ${res.status}` };
    const reader = res.body?.getReader();
    if (!reader) return { verified: false, reason: "Page has no readable body" };
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        return { verified: false, reason: "Page exceeds verification size limit" };
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const m = quoteMatch(body, quote);
    return m === 1 && normalizeText(body).includes(normalizeText(quote))
      ? {
          verified: true,
          reason:
            m === 1
              ? "quote found verbatim on the page"
              : `quote found on the page (${Math.round(m * 100)}% match)`,
        }
      : {
          verified: false,
          reason: `quote not found on the fetched page (${Math.round(m * 100)}% match)`,
        };
  } catch (e) {
    return {
      verified: false,
      reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
