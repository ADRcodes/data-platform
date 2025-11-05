import * as cheerio from "cheerio";
import { parse } from "date-fns";
import { http, polite } from "../net.js";
import { extractEventJsonLd, extractOgImage, normalizeText } from "../dom-utils.js";
import { absoluteUrl, extractFirstImageUrl, firstNonMetaText, contentHash } from "../scrape-helpers.js";

// Accepts "7:00pm October 24, 2025" or "7:00pm OCTOBER 24, 2025"
function parseMajesticDate(line) {
  const m = line?.match(/(\d{1,2}:\d{2}\s*[ap]m)\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (!m) return { starts_at: null, ends_at: null };
  const [, time, month, day, year] = m;
  const normalizedTime = time.replace(/\s*/g, '').replace(/([ap]m)$/i, ' $1'); // "7:00pm" -> "7:00 pm"
  const stamp = `${month} ${day}, ${year} ${normalizedTime}`;
  const dt = parse(stamp, "MMMM d, yyyy h:mma", new Date());
  return { starts_at: dt.toISOString(), ends_at: null };
}

export async function scrapeMajestic() {
  const base = "https://majestictheatrehill.com";
  const url = `${base}/events/`;

  const res = await http.get(url);
  await polite();
  const $ = cheerio.load(res.data);

  const items = [];

  // Try to target card containers; keep your h3/h4 fallback
  $("article, .et_pb_module, .card").each((_, card) => {
    const titleEl = $(card).find("h4, h3").first();
    const title = titleEl.text().trim();
    if (!title) return;

    const lines = $(card).text().split("\n").map(s => s.trim()).filter(Boolean);
    const when = lines.find(s =>
      /\d{1,2}:\d{2}\s*[ap]m\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}/i.test(s)
    );
    const { starts_at, ends_at } = parseMajesticDate(when);

    const venue = lines.find(s => /Majestic|Theatre Hill|Mainstage|Stage/i.test(s)) || null;

    const moreInfo =
      $(card).find("a:contains('Details'), a:contains('Buy Tickets')").first().attr("href") ||
      titleEl.find("a").attr("href") ||
      url;

    const image_url = extractFirstImageUrl($, card, base);
    const description = firstNonMetaText(lines);

    const absoluteMoreInfo = absoluteUrl(base, moreInfo);
    items.push({
      source: "majestic",
      source_id: absoluteMoreInfo || title,
      title,
      starts_at,
      ends_at,
      venue,
      city: "St. John's, NL",
      url: absoluteMoreInfo,
      image_url,
      description,
      tags: ""
    });
  });

  // fallback: if the page doesn’t have obvious cards, use your original loop
  if (items.length === 0) {
    $("h4, h3").each((_, el) => {
      const title = $(el).text().trim();
      if (!title) return;
      const block = $(el).parent();
      const lines = block.text().split("\n").map(s => s.trim()).filter(Boolean);
      const when = lines.find(s => /\d{1,2}:\d{2}\s*[ap]m\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}/i.test(s));
      const { starts_at, ends_at } = parseMajesticDate(when);
      const venue = lines.find(s => /Majestic|Theatre Hill|Mainstage|Stage/i.test(s)) || null;
      const moreInfo = block.find("a:contains('Details'), a:contains('Buy Tickets')").first().attr("href")
        || $(el).find("a").attr("href") || url;

      const absoluteMoreInfo = absoluteUrl(base, moreInfo);
      items.push({
        source: "majestic",
        source_id: absoluteMoreInfo || title,
        title,
        starts_at,
        ends_at,
        venue,
        city: "St. John's, NL",
        url: absoluteMoreInfo,
        image_url: extractFirstImageUrl($, block, base),
        description: firstNonMetaText(lines),
        tags: ""
      });
    });
  }

  // dedup
  const seen = new Set();
  return items
    .filter(it => {
      const k = `${it.source_id}::${it.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(it => ({ ...it, content_hash: contentHash(it) }));
}
