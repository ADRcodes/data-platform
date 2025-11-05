import ical from "node-ical";
import { http, polite } from "./net.js";
import { contentHash } from "./scrape-helpers.js";

function toIso(dt) {
  if (!dt) return null;
  // node-ical returns Date or {toJSDate()}
  const d = (dt instanceof Date) ? dt : dt.toJSDate?.() ?? null;
  return d ? d.toISOString() : null;
}

function asText(x, limit = 800) {
  if (!x) return null;
  const s = String(x).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, limit) : null;
}

/**
 * Pulls one ICS URL and maps VEVENTs to your event rows.
 */
export async function fetchIcs(url, label = null, defaultCity = null) {
  // node-ical can fetch URLs directly, but we use http + polite for consistency & retries
  const res = await http.get(url, { responseType: "text" });
  await polite(200, 400);
  const data = ical.parseICS(res.data);

  const items = [];
  for (const key of Object.keys(data)) {
    const e = data[key];
    if (!e || e.type !== "VEVENT") continue;

    const row = {
      source: "ics",
      source_id: e.uid || `${url}::${e.summary}::${toIso(e.start)}`,
      title: asText(e.summary) || "Untitled",
      starts_at: toIso(e.start),
      ends_at: toIso(e.end),
      venue: asText(e.location),
      city: defaultCity,
      url: e.url || url, // deep-link if present; else the feed
      image_url: null,
      description: asText(e.description),
      tags: label ? `ICS,${label}` : "ICS"
    };
    row.content_hash = contentHash(row);
    items.push(row);
  }
  return items;
}
