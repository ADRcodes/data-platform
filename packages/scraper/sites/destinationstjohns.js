import * as cheerio from "cheerio";
import { isValid, parse } from "date-fns";
import { http, polite } from "../net.js";
import { extractEventJsonLd, extractOgImage, normalizeText } from "../dom-utils.js";
import { absoluteUrl, extractFirstImageUrl } from "../scrape-helpers.js";

function toIso(date) {
  return date && isValid(date) ? date.toISOString() : null;
}

const DATE_FORMATS = [
  "EEEE, MMMM d, yyyy",
  "MMMM d, yyyy",
  "MMMM d yyyy",
  "MMM d, yyyy",
  "MMM dd, yyyy"
];

const DATE_TIME_FORMATS = [
  "EEEE, MMMM d, yyyy h:mm a",
  "EEEE, MMMM d, yyyy h a",
  "EEEE, MMMM d, yyyy HH:mm",
  "MMMM d, yyyy h:mm a",
  "MMMM d, yyyy h a",
  "MMMM d, yyyy HH:mm",
  "MMM d, yyyy h:mm a",
  "MMM d, yyyy h a",
  "MMM d, yyyy HH:mm",
  "MMM dd, yyyy h:mm a",
  "MMM dd, yyyy h a",
  "MMM dd, yyyy HH:mm"
];

function clean(str) {
  return str?.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() || "";
}

function parseDateOnly(str) {
  const input = clean(str);
  if (!input) return null;
  for (const fmt of DATE_FORMATS) {
    const parsed = parse(input, fmt, new Date());
    if (isValid(parsed)) return parsed;
  }
  return null;
}

function parseDateAndTime(dateStr, timeStr) {
  const datePart = clean(dateStr);
  const timePart = clean(timeStr);
  if (!datePart) return null;
  if (!timePart) return parseDateOnly(datePart);

  for (const fmt of DATE_TIME_FORMATS) {
    const parsed = parse(`${datePart} ${timePart}`, fmt, new Date());
    if (isValid(parsed)) return parsed;
  }

  if (/^\d{1,2}:\d{2}$/.test(timePart)) {
    const base = parseDateOnly(datePart);
    if (base && isValid(base)) {
      const [h, m] = timePart.split(":").map(Number);
      const copy = new Date(base);
      copy.setHours(h ?? 0, m ?? 0, 0, 0);
      return copy;
    }
  }

  return null;
}

function startOfDay(date) {
  if (!date || !isValid(date)) return null;
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date) {
  if (!date || !isValid(date)) return null;
  const copy = new Date(date);
  copy.setHours(23, 59, 0, 0);
  return copy;
}

function parseDateTimeRange(dateLine, timeLine) {
  const rawDate = clean(dateLine);
  if (!rawDate) return { starts_at: null, ends_at: null };

  const dateParts = rawDate.split(/\s*[-–—]\s*/).filter(Boolean);
  const startDateStr = dateParts[0];
  const endDateStr = dateParts.length > 1 ? dateParts[dateParts.length - 1] : startDateStr;

  const startDate = parseDateOnly(startDateStr);
  const endDate = parseDateOnly(endDateStr) || startDate;

  const allDay = !timeLine || /all day/i.test(timeLine);
  if (allDay) {
    return {
      starts_at: toIso(startOfDay(startDate)),
      ends_at: toIso(endOfDay(endDate))
    };
  }

  const [startTimeStr, endTimeStr] = clean(timeLine)
    .split(/\s*[-–—]\s*/)
    .map(clean)
    .filter(Boolean);

  const startDateTime = parseDateAndTime(startDateStr, startTimeStr);
  const endDateTime = endTimeStr
    ? parseDateAndTime(endDateStr, endTimeStr)
    : (endDate && startDate && endDate.getTime() !== startDate.getTime()
        ? endOfDay(endDate)
        : null);

  return {
    starts_at: toIso(startDateTime),
    ends_at: toIso(endDateTime)
  };
}

export async function scrapeDestinationStJohns() {
  const base = "https://destinationstjohns.com";
  const url = `${base}/events/calendar/`;

  const res = await http.get(url);
  await polite();

  const $ = cheerio.load(res.data);
  const items = [];

  $(".em-event.em-item").each((_, node) => {
    const card = $(node);
    const title = clean(card.find("h3.em-item-title").first().text());
    if (!title) return;

    const moreInfo =
      card.find("a.em-item-read-more").attr("href") ||
      card.find("h3.em-item-title a").attr("href") ||
      null;
    if (!moreInfo) return;

    const dateLine = clean(card.find(".em-event-date").text());
    const timeLine = clean(card.find(".em-event-time").text());

    const venueLink = card.find(".em-event-location a").first();
    const venue = clean(venueLink.text()) || null;

    const tagTexts = card
      .find(".em-item-taxonomy a")
      .map((_, a) => clean($(a).text()))
      .get()
      .filter(Boolean);
    const tags = tagTexts.join(", ");

    const { starts_at, ends_at } = parseDateTimeRange(dateLine, timeLine);

    const image_url = extractFirstImageUrl($, card, base);
    const description = normalizeText(card.find(".em-item-desc").text()) || null;

    items.push({
      source: "destinationstjohns",
      source_id: absoluteUrl(base, moreInfo) || title,
      title,
      starts_at,
      ends_at,
      venue,
      city: "St. John's, NL",
      url: absoluteUrl(base, moreInfo),
      image_url,
      description,
      tags
    });
  });

  const seen = new Set();
  const unique = items.filter(it => {
    const k = `${it.source_id}::${it.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const enriched = [];
  for (const it of unique) {
    try {
      if (!it.url) {
        enriched.push(it);
        continue;
      }

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
        const p = $$("article p, .entry-content p, .event--left-col p")
          .map((_, e) => $$(e).text())
          .get()
          .join(" ");
        it.description = normalizeText(p)?.slice(0, 600) || null;
      }

      if (!it.starts_at || !it.ends_at) {
        const $$ = cheerio.load(detail.data);
        const startLabel = $$(".event--date span")
          .filter((_, span) => /start date/i.test($$(span).text()))
          .first();
        const endLabel = $$(".event--date span")
          .filter((_, span) => /end date/i.test($$(span).text()))
          .first();

        const rawStartValue = clean(startLabel.nextAll("h3, p").first().text());
        const rawEndValue = clean(endLabel.nextAll("h3, p").first().text());

        let startDateStr = rawStartValue;
        let startTimeStr = "";
        if (rawStartValue.includes(" - ")) {
          const [datePart, timePart] = rawStartValue.split(/\s*-\s*/).map(clean);
          startDateStr = datePart;
          startTimeStr = timePart;
        }

        let endDateStr = rawEndValue;
        let endTimeStr = "";
        if (rawEndValue.includes(" - ")) {
          const [datePart, timePart] = rawEndValue.split(/\s*-\s*/).map(clean);
          endDateStr = datePart;
          endTimeStr = timePart;
        }

        const detailDateLine = endDateStr ? `${startDateStr} - ${endDateStr}` : startDateStr;
        let detailTimeLine = "";
        if (/all day/i.test(rawStartValue) || /all day/i.test(rawEndValue)) {
          detailTimeLine = "All Day";
        } else if (startTimeStr && endTimeStr) {
          detailTimeLine = `${startTimeStr} - ${endTimeStr}`;
        } else if (startTimeStr) {
          detailTimeLine = startTimeStr;
        }

        const parsed = parseDateTimeRange(detailDateLine, detailTimeLine);
        it.starts_at = parsed.starts_at || it.starts_at;
        it.ends_at = parsed.ends_at || it.ends_at;
      }
    } catch (e) {
      console.warn(`enrich failed for ${it.url}:`, e?.message);
    }
    enriched.push(it);
  }

  return enriched;
}
