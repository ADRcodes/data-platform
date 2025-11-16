import * as cheerio from "cheerio";
import { http, polite } from "./net.js";

function pickMeta($, prop) {
  return (
    $(`meta[property="${prop}"], meta[name="${prop}"]`).attr("content") || null
  );
}

function cleanText(value, limit = 800) {
  if (!value) return null;
  const trimmed = String(value).replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

function firstNonNull(...values) {
  for (const value of values) {
    if (value) return value;
  }
  return null;
}

function findEventNode(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findEventNode(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    const type = node["@type"] || node.type;
    if (type) {
      const types = Array.isArray(type) ? type : [type];
      if (types.some((t) => String(t).toLowerCase() === "event")) {
        return node;
      }
    }
    for (const key of Object.keys(node)) {
      const found = findEventNode(node[key]);
      if (found) return found;
    }
  }
  return null;
}

function normaliseDate(value) {
  if (!value) return null;
  const iso = new Date(value);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

function normaliseImage(image) {
  if (!image) return null;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return image.find(Boolean) || null;
  if (typeof image === "object") return image.url || image.primaryImageOfPage || null;
  return null;
}

const MONTH_NAMES =
  "january,february,march,april,may,june,july,august,september,october,november,december".split(
    ","
  );

const TZ_OFFSETS = {
  NST: -210, // UTC-03:30
  NDT: -150, // UTC-02:30
  AST: -240, // UTC-04:00
  ADT: -180, // UTC-03:00
};

const LOGIN_NOISE_REGEX =
  /(facebook\s*log\s*in|facebook|log\s*in|sign\s*up|see posts|forgot account\?|home|events)/gi;

function stripLoginNoise(value) {
  if (!value) return "";
  return value
    .replace(LOGIN_NOISE_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseTimeText(text) {
  return text
    .replace(/\u202f/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bNoon\b/i, "12:00 PM")
    .trim();
}

function parseDateFromText(text) {
  if (!text) return null;
  const cleaned = normaliseTimeText(text);
  const regex =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)(?:\s+([A-Z]{2,3}))?/i;
  const match = cleaned.match(regex);
  if (!match) return null;
  const [, , monthName, dayStr, yearStr, hourStr, minuteStr, meridiem, tzAbbr] =
    match;
  const monthIndex = MONTH_NAMES.indexOf(monthName.toLowerCase());
  if (monthIndex === -1) return null;
  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  const mer = meridiem.toUpperCase();
  if (mer === "PM" && hour < 12) hour += 12;
  if (mer === "AM" && hour === 12) hour = 0;
  const year = parseInt(yearStr, 10);
  const day = parseInt(dayStr, 10);
  if (Number.isNaN(year) || Number.isNaN(day)) return null;
  const offsetMinutes =
    TZ_OFFSETS[tzAbbr?.toUpperCase?.() || ""] ?? null;
  const baseUtc = Date.UTC(year, monthIndex, day, hour, minute);
  const timestamp =
    offsetMinutes != null
      ? baseUtc - offsetMinutes * 60 * 1000
      : baseUtc;
  const iso = new Date(timestamp).toISOString();
  return iso;
}

function decodeFacebookRedirect(url) {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.endsWith("facebook.com") &&
      parsed.pathname.startsWith("/l.php")
    ) {
      const target = parsed.searchParams.get("u");
      if (target) return decodeURIComponent(target);
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Parse a single event page (e.g., a Facebook event HTML document).
 * Returns fields suitable to prefill the admin form.
 */
export function parseOpenGraphFromHtml(html, url) {
  const $ = cheerio.load(html);

  const ogTitle = pickMeta($, "og:title");
  const ogDesc = pickMeta($, "og:description");
  const ogImage = firstNonNull(
    pickMeta($, "og:image"),
    pickMeta($, "og:image:url")
  );

  const metaStart = pickMeta($, "event:start_time") || pickMeta($, "og:start_time");
  const metaEnd = pickMeta($, "event:end_time") || pickMeta($, "og:end_time");
  const metaVenue = firstNonNull(
    pickMeta($, "event:location"),
    pickMeta($, "event:venue"),
    pickMeta($, "place:name")
  );
  const metaCity = firstNonNull(
    pickMeta($, "event:location:city"),
    pickMeta($, "place:location:city"),
    pickMeta($, "og:locale:alternate")
  );

  let ldStart = null;
  let ldEnd = null;
  let ldVenue = null;
  let ldCity = null;
  let ldTickets = null;
  let ldImage = null;

  $("script[type='application/ld+json']").each((_, el) => {
    const text = $(el).contents().text();
    try {
      const parsed = JSON.parse(text.trim());
      const eventNode = findEventNode(parsed);
      if (eventNode) {
        ldStart = ldStart || eventNode.startDate || eventNode.start_time;
        ldEnd = ldEnd || eventNode.endDate || eventNode.end_time;
        const location = eventNode.location || {};
        ldVenue =
          ldVenue ||
          location.name ||
          (typeof location === "string" ? location : null);
        const address = location.address || {};
        ldCity =
          ldCity ||
          address.addressLocality ||
          address.addressRegion ||
          address.addressCountry ||
          null;
        const offers = eventNode.offers;
        if (offers) {
          if (Array.isArray(offers)) {
            ldTickets =
              ldTickets ||
              offers.map((o) => o.url).find(Boolean) ||
              offers.map((o) => o.availabilityStarts).find(Boolean) ||
              null;
          } else if (typeof offers === "object") {
            ldTickets = ldTickets || offers.url || offers.availabilityStarts || null;
          }
        }
        ldImage = ldImage || normaliseImage(eventNode.image);
      }
    } catch {
      // ignore JSON parse errors
    }
  });

  const start_time = normaliseDate(metaStart) || normaliseDate(ldStart);
  const end_time = normaliseDate(metaEnd) || normaliseDate(ldEnd);

  const venue =
    cleanText(metaVenue, 200) ||
    cleanText(ldVenue, 200) ||
    cleanText(
      firstNonNull(
        $("[data-testid='event_permalink_event_location']").text(),
        $(".xz9dl7a.xo1l8bm.x1a2a7pz").first().text()
      ),
      200
    );

  const city = cleanText(metaCity, 120) || cleanText(ldCity, 120);
  const tickets_url = ldTickets || null;

  const textCandidates = [];
  $("body *").each((_, el) => {
    const text = $(el).text();
    if (!text) return;
    const cleaned = cleanText(text);
    if (cleaned) textCandidates.push(cleaned);
  });

  const fallbackDate = textCandidates.find((t) => {
    const lower = t.toLowerCase();
    return (
      MONTH_NAMES.some((m) => lower.includes(m)) &&
      /at\s+\d{1,2}:\d{2}/i.test(t) &&
      /\d{4}/.test(t)
    );
  });

  const fallbackVenue = textCandidates.find(
    (t) =>
      t.includes(" - ") &&
      (t.toLowerCase().includes("centre") ||
        t.toLowerCase().includes("hall") ||
        t.toLowerCase().includes("pub") ||
        t.toLowerCase().includes("st. john"))
  );

  const fallbackCity = textCandidates.find((t) =>
    /Newfoundland|Labrador|St\.\s*John/i.test(t)
  );

  const ticketLink = (() => {
    const anchor = $("a")
      .filter((_, el) => {
        const text = cleanText($(el).text(), 200) || "";
        return /ticket/i.test(text);
      })
      .first();
    if (!anchor.length) return null;
    const href = anchor.attr("href");
    return href ? decodeFacebookRedirect(href) : null;
  })();

  const derivedStart = start_time || parseDateFromText(fallbackDate);
  const cleanedCandidates = textCandidates
    .map(stripLoginNoise)
    .map((text) => text.replace(/^(?:\d+\s*)?((Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday).*)$/i, "$1"))
    .map((text) => text.replace(/(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday).*$/i, "").trim() || text)
    .map((text) => text.replace(/^[0-9]{1,2}\s*/, "").trim())
    .filter((text) => text && text.length > 3 && /[A-Za-z]/.test(text));

  const fallbackTitleCandidate = cleanedCandidates.find((text) => {
    if (/^See\b/i.test(text)) return false;
    if (/^Log\b/i.test(text)) return false;
    if (/^(Home|Event|Events)$/i.test(text)) return false;
    return text.split(" ").length >= 2;
  });

  return {
    title: cleanText(ogTitle) || cleanText(fallbackTitleCandidate, 200),
    description: cleanText(ogDesc),
    image_url: cleanText(ogImage || ldImage),
    start_time: derivedStart,
    end_time: end_time || null,
    venue: venue || cleanText(stripLoginNoise(fallbackVenue), 200),
    city: city || cleanText(stripLoginNoise(fallbackCity), 120),
    tickets_url: ticketLink || tickets_url || null,
    url,
  };
}

/**
 * Fetch a single event page (e.g., a Facebook event URL).
 * Returns fields suitable to prefill the admin form.
 */
export async function fetchOpenGraph(url) {
  const tried = new Set();
  const attempt = async (targetUrl) => {
    tried.add(targetUrl);
    const res = await http.get(targetUrl, { responseType: "text" });
    await polite(200, 400);
    return parseOpenGraphFromHtml(res.data, targetUrl);
  };

  try {
    return await attempt(url);
  } catch (error) {
    const originalHost = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return null;
      }
    })();

    if (!originalHost) throw error;

    const altHosts = [
      originalHost.replace(/^www\./, "m."),
      originalHost.replace(/^www\./, "mbasic."),
    ].filter((host) => host && host !== originalHost);

    for (const host of altHosts) {
      try {
        const altUrl = new URL(url);
        altUrl.hostname = host;
        if (tried.has(altUrl.toString())) continue;
        return await attempt(altUrl.toString());
      } catch (altError) {
        // try next host
      }
    }

    throw error;
  }
}

export { parseDateFromText };
