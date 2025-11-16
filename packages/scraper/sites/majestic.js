import * as cheerio from "cheerio";
import { parse, isValid } from "date-fns";
import { http, polite } from "../net.js";
import logger from "../logger.js";
import { extractEventJsonLd, extractOgImage, normalizeText } from "../dom-utils.js";
import { absoluteUrl, extractFirstImageUrl, firstNonMetaText, contentHash } from "../scrape-helpers.js";

const SKIP_ENRICH = process.env.SCRAPER_SKIP_ENRICH === "1";

function sanitize(value) {
  if (!value) return null;
  const trimmed = String(value).replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function parseMajesticDate(text) {
  const cleaned = sanitize(text);
  if (!cleaned) return { starts_at: null, ends_at: null };

  const singleMatch = cleaned.match(/(\d{1,2}(?::\d{2})?\s*[ap]m)\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (singleMatch) {
    const [, time, month, day, year] = singleMatch;
    const normalizedTime = time.replace(/\s+/g, "").toLowerCase();
    const stamp = `${month} ${day}, ${year} ${normalizedTime}`;
    const formats = normalizedTime.includes(":")
      ? ["MMMM d, yyyy h:mma", "MMMM d, yyyy h:mm a"]
      : ["MMMM d, yyyy ha", "MMMM d, yyyy h a"];
    for (const fmt of formats) {
      const dt = parse(stamp, fmt, new Date());
      if (isValid(dt)) return { starts_at: dt.toISOString(), ends_at: null };
    }
  }

  const rangeMatch = cleaned.match(/([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2}),\s*(\d{4})/i);
  if (rangeMatch) {
    const [, month, startDay, endDay, year] = rangeMatch;
    const startStamp = `${month} ${startDay}, ${year} 12:00 am`;
    const endStamp = `${month} ${endDay}, ${year} 11:59 pm`;
    const startDate = parse(startStamp, "MMMM d, yyyy h:mm a", new Date());
    const endDate = parse(endStamp, "MMMM d, yyyy h:mm a", new Date());
    return {
      starts_at: isValid(startDate) ? startDate.toISOString() : null,
      ends_at: isValid(endDate) ? endDate.toISOString() : null,
    };
  }

  return { starts_at: null, ends_at: null };
}

function normalizePriceText(value) {
  return value?.replace(/\s+/g, " ").replace(/\bFees\b/gi, "fees").trim() || null;
}

function pickStandardPrice(text) {
  const cleaned = normalizePriceText(text);
  if (!cleaned) return null;
  const parts = cleaned
    .split(/[;|]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const preferred =
    parts.find((segment) => /standard|general/i.test(segment)) ||
    parts.find((segment) => /\$\s*\d/.test(segment)) ||
    null;
  if (!preferred) return null;
  const chunk = preferred.includes(":")
    ? preferred.split(":").slice(1).join(":").trim()
    : preferred.trim();
  return normalizePriceText(chunk);
}

function extractPriceFromDom($$) {
  const selectors = [
    ".mpspx-event-single-prices .font-lg",
    ".mpspx-event-single-prices",
    ".event-single .font-lg",
    ".single .font-lg",
    ".entry-content p",
  ];
  for (const selector of selectors) {
    const node = $$(selector)
      .filter((_, el) => /\$\s*\d/.test($$(el).text()))
      .first();
    if (!node.length) continue;
    const candidate = pickStandardPrice(node.text());
    if (candidate) return candidate;
  }
  return null;
}

function formatPriceValue(value) {
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return value === 0 ? "Free" : null;
  const hasCents = Math.abs(value - Math.round(value)) > 0.001;
  const formatted = hasCents ? value.toFixed(2) : String(Math.round(value));
  return `$${formatted}`;
}

function extractEventScriptData(html) {
  const match = html.match(/var\s+EVENT\s*=\s*(\{[\s\S]*?\})\s*;/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractPriceFromScriptData(data) {
  if (!data) return null;
  const priceBuckets = data?.prices?.min || data?.prices || null;
  if (!priceBuckets || typeof priceBuckets !== "object") return null;
  const tier = data?.prices?.default;
  let numeric = null;
  if (tier && Object.prototype.hasOwnProperty.call(priceBuckets, tier)) {
    numeric = priceBuckets[tier];
  }
  if (!Number.isFinite(numeric)) {
    const first = Object.values(priceBuckets).find(
      (val) => typeof val === "number" && val > 0
    );
    if (typeof first === "number") {
      numeric = first;
    }
  }
  return formatPriceValue(numeric);
}

function extractStartFromScriptData(data) {
  const start = data?.start;
  if (!start) return null;
  const dt = new Date(start);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function applyDetail(event, detail) {
  if (!detail) return event;
  if (detail.title) event.title = detail.title;
  if (detail.description && (!event.description || event.description === event.title)) {
    event.description = detail.description;
  }
  if (detail.image_url && !event.image_url) event.image_url = detail.image_url;
  if (detail.starts_at && !event.starts_at) event.starts_at = detail.starts_at;
  if (detail.ends_at && !event.ends_at) event.ends_at = detail.ends_at;
  if (detail.venue && !event.venue) event.venue = detail.venue;
  if (detail.city && !event.city) event.city = detail.city;
  if (detail.url && !event.url) event.url = detail.url;
  if (detail.price) event.price = detail.price;
  return event;
}

async function fetchMajesticDetail(detailUrl) {
  if (!detailUrl) return null;
  try {
    const timeout = Number.parseInt(process.env.MAJESTIC_DETAIL_TIMEOUT ?? "60000", 10);
    await polite(450, 650);
    const res = await http.get(detailUrl, {
      responseType: "text",
      timeout,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    await polite(250, 450);
    const html = res.data;
    const $$ = cheerio.load(html);
    const eventScript = extractEventScriptData(html);

    const detail = { url: detailUrl };

    const ld = extractEventJsonLd(html);
    if (ld) {
      detail.title = ld.title || ld.name || null;
      detail.starts_at = ld.startDate || ld.start_time || null;
      detail.ends_at = ld.endDate || ld.end_time || null;
      detail.description = normalizeText(ld.description) || null;
      const location = ld.location || {};
      const address = location.address || {};
      detail.venue = location.name || null;
      detail.city = address.addressLocality || address.addressRegion || address.addressCountry || null;
    }

    detail.image_url = extractOgImage(html);

    if (!detail.description) {
      detail.description = normalizeText(
        $$(".single-event .entry-content, .single .entry-content, .et_pb_text_inner")
          .first()
          .text()
      );
    }

    if (!detail.starts_at) {
      const dateAttr =
        $$('time[itemprop="startDate"]').attr("datetime") ||
        $$('meta[itemprop="startDate"]').attr("content");
      if (dateAttr) {
        const parsed = new Date(dateAttr);
        if (!Number.isNaN(parsed.getTime())) detail.starts_at = parsed.toISOString();
      }
      if (!detail.starts_at) {
        const scriptStart = extractStartFromScriptData(eventScript);
        if (scriptStart) detail.starts_at = scriptStart;
      }
    }

    if (!detail.venue) {
      detail.venue = normalizeText(
        $$(".event-venue, .venue, .et_pb_text_inner strong").first().text()
      );
    }

    if (!detail.city) {
      detail.city = normalizeText(
        $$(".event-city, .et_pb_text_inner").filter((_, el) => /NL|Newfoundland/i.test($$(el).text()))
          .first()
          .text()
      ) || null;
    }

    const scriptPrice = extractPriceFromScriptData(eventScript);
    detail.price = extractPriceFromDom($$) || scriptPrice || null;

    return detail;
  } catch (error) {
    logger.warn?.("Majestic detail fetch failed", detailUrl, error?.message || error);
    return null;
  }
}

export async function scrapeMajestic() {
  const base = "https://majestictheatrehill.com";
  const url = `${base}/events/`;

  const res = await http.get(url);
  await polite();
  const $ = cheerio.load(res.data);

  const items = [];

  $(".mpspx-event-griditem-wrapper").each((_, element) => {
    const card = $(element);
    const title = sanitize(card.find(".mpspx-event-griditem-title").text());
    if (!title) return;

    const moreInfo = card
      .find(".mpspx-event-griditem-title a, .mpspx-button2")
      .first()
      .attr("href") || url;
    const absoluteMoreInfo = absoluteUrl(base, moreInfo);

    const stage = sanitize(card.find(".genre-banner span").text());
    const dateText = sanitize(card.find(".mpspx-event-griditem-time").text());
    const description =
      sanitize(card.find(".description").text()) ||
      sanitize(
        firstNonMetaText(
          card
            .text()
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        )
      ) ||
      null;
    const imageUrl = extractFirstImageUrl($, element, base);

    const { starts_at, ends_at } = parseMajesticDate(dateText);

    items.push({
      source: "majestic",
      source_id: absoluteMoreInfo || title,
      title,
      starts_at,
      ends_at,
      venue: stage || "The Majestic Theatre",
      city: "St. John's, NL",
      url: absoluteMoreInfo,
      image_url: imageUrl,
      description,
      price: null,
      tags: ""
    });
  });

  const seen = new Set();
  const unique = items.filter(it => {
    const k = `${it.source_id}::${it.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (SKIP_ENRICH) {
    return unique.map(it => ({ ...it, content_hash: contentHash(it) }));
  }

  const enriched = [];
  for (const event of unique) {
    if (event.url) {
      try {
        const detail = await fetchMajesticDetail(event.url);
        applyDetail(event, detail);
      } catch (error) {
        logger.warn?.("Majestic enrich failed", event.url, error?.message || error);
      }
    }
    enriched.push(event);
  }

  return enriched.map(it => ({ ...it, content_hash: contentHash(it) }));
}
