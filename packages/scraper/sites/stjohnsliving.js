import axios from "axios";
import ical from "node-ical";
import logger from "../logger.js";
import { contentHash } from "../scrape-helpers.js";
import { polite } from "../net.js";

const DEFAULT_FEED_URL = "https://stjohnsliving.ca/events/list/?ical=1";
const DEFAULT_CITY = "St. John's, NL";

function sanitizeText(value) {
  if (!value) return null;
  return String(value).replace(/\s+/g, " ").trim() || null;
}

function deriveVenue(event) {
  const location = sanitizeText(event.location);
  if (!location) return { venue: null, city: DEFAULT_CITY };
  const parts = location.split(",");
  const venue = parts[0]?.trim() || null;
  // Attempt to derive city from remainder; fallback to default.
  const cityCandidates = parts.slice(1).join(",").trim();
  const city = cityCandidates || DEFAULT_CITY;
  return { venue, city };
}

function collectTags(event) {
  const categories = event.categories;
  if (!categories) return "";
  if (Array.isArray(categories)) return categories.map(sanitizeText).filter(Boolean).join(", ");
  return sanitizeText(categories) ?? "";
}

export async function scrapeStJohnsLiving() {
  const feedUrl = process.env.STJOHNSLIVING_ICS_URL ?? DEFAULT_FEED_URL;

  let response;
  try {
    const timeout = Number.parseInt(process.env.STJOHNSLIVING_TIMEOUT ?? "45000", 10);
    response = await axios.get(feedUrl, {
      responseType: "text",
      timeout,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; data-platform-bot/1.0)",
        Accept: "text/calendar",
      },
    });
    await polite(200, 400);
  } catch (err) {
    logger.error("StJohnsLiving: failed to download ICS feed:", err?.message ?? err);
    throw err;
  }

  let parsed;
  try {
    parsed = ical.sync.parseICS(response.data);
  } catch (err) {
    logger.error("StJohnsLiving: failed to parse ICS feed:", err?.message ?? err);
    throw err;
  }

  const events = [];
  for (const key of Object.keys(parsed)) {
    const entry = parsed[key];
    if (!entry || entry.type !== "VEVENT") continue;

    const title = sanitizeText(entry.summary) || "Untitled Event";
    const { venue, city } = deriveVenue(entry);
    const url = sanitizeText(entry.url || entry["X-TRIBE-EVENT-URL"]);
    const description =
      sanitizeText(entry.description) ||
      sanitizeText(entry["X-TRIBE-EVENT-DESCRIPTION"]);

    const baseEvent = {
      source: "stjohnsliving",
      source_id: sanitizeText(entry.uid || entry["UID"] || entry["X-TRIBE-EVENT-ID"] || `${title}-${entry.start?.toISOString?.()}`),
      title,
      starts_at: entry.start ? new Date(entry.start).toISOString() : null,
      ends_at: entry.end ? new Date(entry.end).toISOString() : null,
      venue,
      city: city || DEFAULT_CITY,
      url: url || null,
      image_url: null,
      description,
      tags: collectTags(entry),
    };

    if (!baseEvent.source_id) continue; // skip if we cannot confidently identify

    events.push({ ...baseEvent, content_hash: contentHash(baseEvent) });
  }

  logger.info(`StJohnsLiving: parsed ${events.length} events from ICS feed.`);
  return events;
}

export default scrapeStJohnsLiving;
