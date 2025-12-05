import * as cheerio from "cheerio";
import { chromium } from "playwright";
import logger from "../logger.js";
import { http, polite } from "../net.js";
import { contentHash, absoluteUrl } from "../scrape-helpers.js";
import { normalizeText } from "../dom-utils.js";

const SHOWPASS_BASE = "https://www.showpass.com";
const SHOWPASS_SEARCH_URL = `${SHOWPASS_BASE}/s/events/St.%20John%27s,NL,Canada`;
const DEFAULT_POINT_LOCATION = "47.5556097,-52.7452511,100";
const DEFAULT_DISCOVERY_URL = `${SHOWPASS_BASE}/api/public/discovery/?location__point_location=${encodeURIComponent(DEFAULT_POINT_LOCATION)}&page_size=12&payment_type=2&purchase_platform=psp_web&source_channel=discovery`;
const MAX_PAGES = 8;
const SKIP_ENRICH = process.env.SCRAPER_SKIP_ENRICH === "1";

function normalizeApiUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, SHOWPASS_BASE);
    parsed.protocol = "https:";
    if (parsed.hostname === "app-web-server-service") parsed.hostname = new URL(SHOWPASS_BASE).hostname;
    parsed.port = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function pickDiscoveryQuery(dehydratedState) {
  const queries = dehydratedState?.queries || [];
  return queries.find(q => q?.state?.data?.pages?.[0]?.results);
}

async function loadInitialPages() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(SHOWPASS_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    const dehydratedState = await page.evaluate(() => globalThis.__NEXT_DATA__?.props?.pageProps?.dehydratedState || null);
    const query = pickDiscoveryQuery(dehydratedState);
    const pages = query?.state?.data?.pages || [];
    const next = pages[pages.length - 1]?.next || null;
    return { pages, next };
  } catch (err) {
    logger.error("Showpass: failed to load listing via Playwright:", err?.message ?? err);
    return { pages: [], next: null };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fetchDiscoveryPage(url) {
  const normalized = normalizeApiUrl(url);
  if (!normalized) return null;
  const res = await http.get(normalized, {
    timeout: 45000,
    headers: {
      Accept: "application/json",
      Referer: SHOWPASS_SEARCH_URL
    }
  });
  await polite(200, 300);
  return res.data;
}

async function collectDiscoveryResults() {
  const initial = await loadInitialPages();
  const results = [];
  for (const page of initial.pages) {
    if (page?.results?.length) results.push(...page.results);
  }

  let nextUrl = initial.next ? normalizeApiUrl(initial.next) : null;
  let pageCount = initial.pages.length || 0;

  while (nextUrl && pageCount < MAX_PAGES) {
    try {
      const data = await fetchDiscoveryPage(nextUrl);
      if (!data) break;
      if (Array.isArray(data.results)) results.push(...data.results);
      nextUrl = normalizeApiUrl(data.next);
      pageCount += 1;
    } catch (err) {
      logger.warn("Showpass: pagination request failed:", err?.message ?? err);
      break;
    }
  }

  // Fallback if Playwright failed to return anything
  if (!results.length) {
    try {
      const data = await fetchDiscoveryPage(DEFAULT_DISCOVERY_URL);
      if (data?.results?.length) {
        results.push(...data.results);
        nextUrl = normalizeApiUrl(data.next);
        pageCount = 1;
        while (nextUrl && pageCount < MAX_PAGES) {
          const pageData = await fetchDiscoveryPage(nextUrl);
          if (!pageData) break;
          if (Array.isArray(pageData.results)) results.push(...pageData.results);
          nextUrl = normalizeApiUrl(pageData.next);
          pageCount += 1;
        }
      }
    } catch (err) {
      logger.warn("Showpass: API fallback failed:", err?.message ?? err);
    }
  }

  return results;
}

function sanitizeDescription(html, fallback) {
  if (html) {
    try {
      const $$ = cheerio.load(html);
      const text = normalizeText($$.text());
      if (text) return text;
    } catch {
      /* ignore parse errors */
    }
    const stripped = normalizeText(html.replace(/<[^>]+>/g, " "));
    if (stripped) return stripped;
  }
  return normalizeText(fallback) || null;
}

function formatPrice(ticketTypes) {
  if (!Array.isArray(ticketTypes)) return null;
  const values = ticketTypes
    .map(tt => (typeof tt?.price === "string" ? Number.parseFloat(tt.price) : Number(tt?.price)))
    .filter(Number.isFinite)
    .filter(v => v >= 0);
  if (!values.length) return null;
  const min = Math.min(...values);
  if (min === 0) return "Free";
  const rounded = Math.abs(min - Math.round(min)) < 0.001 ? String(Math.round(min)) : min.toFixed(2);
  return `$${rounded}`;
}

function formatCity(location) {
  const city = normalizeText(location?.city);
  const province = normalizeText(location?.province || location?.state);
  if (city && province) return `${city}, ${province}`;
  if (city) return city;
  return "St. John's, NL";
}

function normalizeTags(rawTags, rawCategories) {
  const values = [];
  const add = value => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    const text = normalizeText(String(value).replace(/_/g, " "));
    if (text) values.push(text);
  };
  add(rawTags);
  add(rawCategories);
  const seen = new Set();
  return values.filter(tag => {
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(", ");
}

function slugFromResult(result) {
  if (result?.slug) return result.slug;
  const url = result?.frontend_details_url || result?.public_url || result?.url;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    return path || null;
  } catch {
    return null;
  }
}

function mapResultToEvent(result) {
  const slug = slugFromResult(result);
  const title = normalizeText(result?.name) || normalizeText(result?.title) || "Untitled Event";
  const location = result?.location || result?.venue || {};
  const url = result?.frontend_details_url || result?.public_url || (slug ? `${SHOWPASS_BASE}/${slug}/` : null);

  return {
    baseSlug: slug,
    event: {
      source: "showpass",
      source_id: slug || result?.uuid || result?.item_id || title,
      title,
      starts_at: result?.starts_on || null,
      ends_at: result?.ends_on || null,
      venue: normalizeText(location?.name || result?.venue?.name),
      city: formatCity(location),
      url: absoluteUrl(SHOWPASS_BASE, url),
      image_url: result?.image || result?.image_banner || result?.thumbnail || null,
      description: normalizeText(result?.description_without_html) || null,
      price: null,
      tags: normalizeTags(result?.tags, result?.categories)
    }
  };
}

async function fetchEventDetail(slug) {
  if (!slug) return null;
  try {
    const res = await http.get(`${SHOWPASS_BASE}/api/public/events/${slug}/`, { timeout: 25000 });
    await polite(200, 300);
    return res.data;
  } catch (err) {
    logger.warn(`Showpass: failed to fetch detail for ${slug}:`, err?.message ?? err);
    return null;
  }
}

function applyDetail(event, detail) {
  if (!detail) return event;
  event.title = normalizeText(detail.name) || event.title;
  event.starts_at = detail.starts_on || event.starts_at;
  event.ends_at = detail.ends_on || event.ends_at;
  event.venue = normalizeText(detail.venue?.name) || event.venue;
  event.city = formatCity(detail.location) || event.city;
  event.url = absoluteUrl(SHOWPASS_BASE, detail.frontend_details_url || event.url);
  event.image_url = detail.image || detail.image_banner || detail.thumbnail || event.image_url;
  event.description = sanitizeDescription(detail.description, detail.description_without_html) || event.description;
  event.price = formatPrice(detail.ticket_types) || event.price;
  const mergedTags = normalizeTags(detail.tags, detail.categories);
  if (mergedTags && (!event.tags || event.tags.length === 0)) {
    event.tags = mergedTags;
  }
  return event;
}

export async function scrapeShowpass() {
  const results = await collectDiscoveryResults();
  if (!results.length) return [];

  const mapped = results.map(mapResultToEvent);
  const seen = new Set();
  const unique = mapped.filter(item => {
    const key = item.event.source_id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (SKIP_ENRICH) {
    return unique.map(({ event }) => ({ ...event, content_hash: contentHash(event) }));
  }

  const enriched = [];
  for (const { baseSlug, event } of unique) {
    if (!baseSlug) {
      enriched.push({ ...event, content_hash: contentHash(event) });
      continue;
    }
    const detail = await fetchEventDetail(baseSlug);
    applyDetail(event, detail);
    enriched.push({ ...event, content_hash: contentHash(event) });
  }

  return enriched;
}

export default scrapeShowpass;
