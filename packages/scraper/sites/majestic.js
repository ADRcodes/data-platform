import * as cheerio from "cheerio";
import { parse } from "date-fns";
import { http, polite } from "../net.js";
import { extractEventJsonLd, extractOgImage, normalizeText } from "../dom-utils.js";

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
  const url = "https://majestictheatrehill.com/events/";
  const res = await http.get(url);
  await polite();
  const $ = cheerio.load(res.data);

  const items = [];
  // Cards have H4/H3; keep your approach but be generous
  $("h4, h3").each((_, el) => {
    const title = $(el).text().trim();
    if (!title) return;

    const block = $(el).closest("article, .card, .wp-block, .et_pb_module, div"); // broaden
    const textLines = block.text().split("\n").map(s => s.trim()).filter(Boolean);

    const when = textLines.find(s =>
      /\d{1,2}:\d{2}\s*[ap]m\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}/i.test(s)
    );

    const { starts_at, ends_at } = parseMajesticDate(when);
    const venue = textLines.find(s => /Majestic|Theatre Hill|Mainstage|Stage/i.test(s)) || null;

    // Prefer "Details" button, else any link in the block, else title link
    const moreInfo =
      block.find("a:contains('Details'), a:contains('Buy Tickets')").first().attr("href")
      || $(el).find("a").attr("href")
      || url;

    items.push({
      source: "majestic",
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

  const unique = dedup(items);

  // Enrich by visiting the event page
  const out = [];
  for (const it of unique) {
    try {
      if (!it.url || it.url === url) { out.push(it); continue; }
      const detail = await http.get(it.url);
      await polite(300, 300);

      const ld = extractEventJsonLd(detail.data);
      if (ld) {
        it.title = ld.title || it.title;
        it.starts_at = ld.starts_at || it.starts_at;
        it.ends_at = ld.ends_at || it.ends_at;
        it.venue = ld.venue || it.venue;
        it.image_url = ld.image_url || it.image_url;
        it.description = normalizeText(ld.description) || it.description;
      }

      if (!it.image_url) it.image_url = extractOgImage(detail.data);

      if (!it.description) {
        const $$ = cheerio.load(detail.data);
        const p = $$("article p, .entry-content p, .et_pb_text_inner p")
          .map((_, e) => $$(e).text()).get().join(" ");
        it.description = normalizeText(p)?.slice(0, 600) || null;
      }
    } catch (e) {
      console.warn(`majestic enrich failed for ${it.url}:`, e?.message);
    }
    out.push(it);
  }
  return out.filter(it => it.title && it.url);
}

function dedup(list) {
  const seen = new Set();
  return list.filter(it => {
    const k = `${it.source_id}::${it.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
