import { z } from "zod";

export const SECRET_NAMES = [
  "anthropic_api_key",
  "openai_api_key",
  "google_api_key",
  "tavily_api_key",
  "firecrawl_api_key",
  "youtube_api_key",
  "apify_api_token",
  "x_bearer_token",
  "reddit_client_id",
  "reddit_client_secret",
  "reddit_refresh_token",
  "openalex_api_key",
] as const;
export const SecretName = z.enum(SECRET_NAMES);
export type SecretName = z.infer<typeof SecretName>;
