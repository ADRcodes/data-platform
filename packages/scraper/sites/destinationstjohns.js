import * as cheerio from "cheerio";
import { isValid, parse } from "date-fns";
import { http, polite } from "../net.js";
import { extractEventJsonLd, extractOgImage, normalizeText } from "../dom-utils.js";

function toIso(date) { return date && isValid(date) ? date.toISOString() : null; }

// "Friday, October 31, 2025" + "12:00 pm - 10:00 pm" or "All Day"
function parseDateTime(dateLine, timeLine) {
  const base = dateLine?.trim();
  if (!base) return { starts_at: null, ends_at: null };

  if (!timeLine || /All Day/i.test(timeLine)) {
    const start = toIso(parse(`${base} 12:00 am`, "EEEE, MMMM d, yyyy h:mm a", new Date()));
    const end = toIso(parse(`${base} 11:59 pm`, "EEEE, MMMM d, yyyy h:mm a", new Date()));
    return { starts_at: start, ends_at: end };
  }
  const [startStr, endStr] = timeLine.split("-").map(s => s.trim()).filter(Boolean);
  const start = toIso(parse(`${base} ${startStr}`, "EEEE, MMMM d, yyyy h:mm a", new Date()));
  const end = endStr ? toIso(parse(`${base} ${endStr}`, "EEEE, MMMM d, yyyy h:mm a", new Date())) : null;
  return { starts_at: start, ends_at: end };
}

export async function scrapeDestinationStJohns() {
  const url = "https://destinationstjohns.com/events/calendar/";
  const res = await http.get(url);
  await polite();
  const $ = cheerio.load(res.data);

  const items = [];

  // Listing parse (keeps your current logic)
  $("h3").each((_, el) => {
    const title = $(el).text().trim();
    if (!title) return;

    const container = $(el).parent();
    const lines = container.text().split("\n").map(s => s.trim()).filter(Boolean);
    const dateLine = lines.find(s => /,\s+\d{4}$/.test(s));
    const timeLine = lines.find(s => /am|pm|All Day/i.test(s) && s !== dateLine);

    const venueLink = container.find("a").filter((_, a) => {
      const t = $(a).text().trim().toLowerCase();
      return t && !/more info|image|submit an event/i.test(t);
    }).first();
    const venue = venueLink.text().trim() || null;

    const moreInfo = container.find("a").filter((_, a) => /more info/i.test($(a).text())).attr("href")
      || $(el).find("a").attr("href") || url;

    const { starts_at, ends_at } = parseDateTime(dateLine, timeLine);

    items.push({
      source: "destinationstjohns",
      source_id: moreInfo || title,
      title,
      starts_at,
      ends_at,
      venue,
      city: "St. John's, NL",
      url: moreInfo,
      image_url: null,
      description: null,
      tags: ""
    });
  });

  // Dedup by (source_id, title)
  const seen = new Set();
  const unique = items.filter(it => {
    const k = `${it.source_id}::${it.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // ENRICH: Visit each event page for JSON-LD / og:image / description, and fill missing dates.
  const enriched = [];
  for (const it of unique) {
    try {
      if (!it.url || it.url === url) { enriched.push(it); continue; }
      const detail = await http.get(it.url);
      await polite(300, 300);

      // Prefer JSON-LD
      const ld = extractEventJsonLd(detail.data);
      if (ld) {
        it.title = ld.title || it.title;
        it.starts_at = ld.starts_at || it.starts_at;
        it.ends_at = ld.ends_at || it.ends_at;
        it.venue = ld.venue || it.venue;
        it.image_url = ld.image_url || it.image_url;
        it.description = normalizeText(ld.description) || it.description;
      }

      // og:image as fallback
      if (!it.image_url) it.image_url = extractOgImage(detail.data);

      // crude HTML fallback for description if still empty
      if (!it.description) {
        const $$ = cheerio.load(detail.data);
        const p = $$("article p, .entry-content p").map((_, e) => $$(e).text()).get().join(" ");
        it.description = normalizeText(p)?.slice(0, 600) || null;
      }
    } catch (e) {
      // keep partial item; log for visibility
      console.warn(`enrich failed for ${it.url}:`, e?.message);
    }
    enriched.push(it);
  }

  return enriched;
}
