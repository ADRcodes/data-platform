import { createClient } from "@supabase/supabase-js";
import logger from "./logger.js";

let cached;

function readEnv(name) {
  return (process.env[name] ?? "").trim();
}

export function hasSupabaseConfig() {
  return Boolean(readEnv("SUPABASE_URL") && readEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

export function getSupabaseClient() {
  if (cached) return cached;
  const url = readEnv("SUPABASE_URL");
  const serviceKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    logger.error("Supabase environment variables are missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    throw new Error("Supabase environment not configured");
  }
  cached = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        "X-Client-Info": "dp-scraper/1.0",
      },
    },
  });
  return cached;
}
