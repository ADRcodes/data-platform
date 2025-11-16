import { chromium } from "playwright";
import ical from "node-ical";
import logger from "./logger.js";
import { http, polite } from "./net.js";
import { fetchOpenGraph, parseOpenGraphFromHtml, parseDateFromText } from "./og.js";

const DEFAULT_TIMEOUT = 45000;
const VIEWPORT = { width: 1280, height: 720 };
const EVENT_SELECTORS = [
  "[data-pagelet='Event']",
  "[data-testid='event_permalink_document']",
  "[data-testid='event-permalink-container']",
  "article[data-pagelet]",
];

function toMobileUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("facebook.com")) return url;
    if (parsed.hostname === "m.facebook.com") return url;
    parsed.hostname = "m.facebook.com";
    return parsed.toString();
  } catch {
    return url;
  }
}

async function hasEventContent(page) {
  return page
    .evaluate((selectors) =>
      selectors.some((selector) => document.querySelector(selector))
    , EVENT_SELECTORS)
    .catch(() => false);
}

function normaliseResult(prefill, fallbacks = {}) {
  const merged = { ...prefill };
  for (const [key, value] of Object.entries(fallbacks)) {
    if (!merged[key] && value) {
      merged[key] = value;
    }
  }
  return merged;
}

async function collectFallbacks(page) {
  return page
    .evaluate(() => {
      const getText = (node) => node?.textContent?.trim?.() || null;
      const queryAll = (selector) => Array.from(document.querySelectorAll(selector));

      const title = (() => {
        for (const selector of [
          "[data-testid='event-permalink-event-name']",
          "h1",
        ]) {
          const node = document.querySelector(selector);
          const text = getText(node);
          if (text) return text;
        }
        return null;
      })();

      const timeNodes = queryAll(
        "[data-testid='event-permalink-event-date'] time, [data-testid='event-permalink-event-time'] time, time[datetime]"
      );
      const startIso = timeNodes[0]?.getAttribute?.("datetime") || null;
      const endIso = timeNodes[1]?.getAttribute?.("datetime") || null;

      const timeLabels = queryAll(
        "[data-testid='event-permalink-event-date'], [data-testid='event-permalink-event-time']"
      )
        .map((node) => getText(node))
        .filter(Boolean);
      let rawRangeText = null;
      if (timeLabels.length > 1) {
        const rest = timeLabels.slice(1).join(" ");
        rawRangeText = timeLabels[0].includes(" at ")
          ? `${timeLabels[0]} ${rest}`
          : `${timeLabels[0]} at ${rest}`;
      } else {
        rawRangeText = timeLabels[0] || null;
      }
      if (rawRangeText) {
        rawRangeText = rawRangeText.replace(/\s+/g, " ").trim();
      }

      let startText = rawRangeText;
      let endText = null;
      if (rawRangeText && /[–-]/.test(rawRangeText)) {
        const parts = rawRangeText.split(/\s+[–-]\s+/);
        const startPart = parts[0]?.trim();
        const endPart = parts[1]?.trim();
        if (startPart) startText = startPart;
        if (startPart && endPart) {
          const datePart = startPart.split(/\bat\b/i)[0]?.trim();
          if (datePart) {
            endText = `${datePart} at ${endPart}`;
          } else {
            endText = endPart;
          }
        }
      }

      if (!startText && startIso) {
        startText = startIso;
      }
      if (!endText && endIso) {
        endText = endIso;
      }

      const locationNode = document.querySelector("[data-testid='event-permalink-event-location']");
      let venue = null;
      let city = null;
      if (locationNode) {
        const rawChunks = [];
        locationNode.querySelectorAll("span, a, div").forEach((node) => {
          const text = getText(node);
          if (text) rawChunks.push(text);
        });

        const uniqueChunks = [];
        for (const chunk of rawChunks) {
          if (!uniqueChunks.includes(chunk)) uniqueChunks.push(chunk);
        }

        const monthRegex = /(january|february|march|april|may|june|july|august|september|october|november|december)/i;
        const discardRegex = /(get directions|view map)/i;
        const loginCleanup = /(facebook\s*log\s*in|log\s*in|sign\s*up|forgot\s*account\?|events|home)/gi;
        const locationCandidates = [];

        for (const chunk of uniqueChunks) {
          if (!chunk) continue;
          const normalized = chunk.replace(/\s+/g, " ").trim();
          if (!normalized) continue;

          if (monthRegex.test(normalized) && /\d{1,2}:\d{2}/.test(normalized)) {
            if (!startText) startText = normalized;
            continue;
          }
          if (discardRegex.test(normalized)) continue;
          const cleaned = normalized.replace(loginCleanup, " ").replace(/\s+/g, " ").trim();
          if (!cleaned) continue;
          locationCandidates.push(cleaned);
        }

        if (!locationCandidates.length && startIso) {
          locationCandidates.push(startIso);
        }

        if (locationCandidates.length) {
          venue = locationCandidates[0] || null;
          if (locationCandidates.length > 1) {
            city = locationCandidates.slice(1).join(", ") || null;
          }
        }
      }

      const descriptionNode =
        document.querySelector("[data-testid='event-permalink-details']") ||
        document.querySelector("[data-testid='event-permalink-event-description']");
      const description = getText(descriptionNode);

      const imageNode =
        document.querySelector("img[data-imgperflogname='profileCoverPhoto']") ||
        document.querySelector("img[referrerpolicy][src*='scontent']");
      const imageUrl = imageNode?.getAttribute?.("src")?.trim?.() || null;

      const cleanupTicketUrl = (href) => {
        if (!href) return null;
        try {
          const parsed = new URL(href, location.href);
          if (parsed.hostname.endsWith("facebook.com") && parsed.pathname.startsWith("/l.php")) {
            const target = parsed.searchParams.get("u");
            if (target) return decodeURIComponent(target);
          }
          return parsed.href;
        } catch {
          return href;
        }
      };

      const ticketAnchor = queryAll("a[href]").find((node) => {
        const text = getText(node) || "";
        const href = node.getAttribute("href") || "";
        return /ticket/i.test(text) || /ticket/i.test(href);
      });
      const ticketsUrl = cleanupTicketUrl(ticketAnchor?.getAttribute("href")?.trim?.() || null);

      return {
        title,
        description,
        start_time_text: startText,
        end_time_text: endText,
        start_time_iso: startIso,
        end_time_iso: endIso,
        venue,
        city,
        image_url: imageUrl,
        tickets_url: ticketsUrl,
        raw_location_text: locationNode?.innerText || null,
      };
    })
    .catch(() => ({}));
}

async function hideLoginOverlays(page) {
  await page
    .addStyleTag({
      content: `
        [role='dialog'],
        [aria-modal='true'],
        #login_popup_cta_form,
        div[data-testid='login_form'],
        div[data-testid='cookie-policy-banner'],
        div[data-testid='cookie-policy-manage-dialog'] {
          display: none !important;
        }
        body { overflow: auto !important; }
      `,
    })
    .catch(() => {});
}

function isProbablyLoginWall(html) {
  return /you must log in/i.test(html) && /facebook/i.test(html);
}

function safeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanLocation(value, limit = 160) {
  if (!value) return null;
  const cleaned = value
    .replace(/Facebook\s+Log\s+In.*$/i, "")
    .replace(/Log\s+In\s+Forgot\s+Account\?/i, "")
    .replace(/^Events\b/i, "")
    .replace(/^Home\b/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > limit ? cleaned.slice(0, limit).trim() : cleaned;
}

function parseDateRangeString(text) {
  if (!text) return null;
  const pattern = /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)(?:\s*[–-]\s*(\d{1,2}:\d{2}\s*[AP]M))?(?:\s*([A-Z]{2,4}))?/i;
  const match = text.match(pattern);
  if (!match) return null;
  const [full, weekday, month, dayStr, yearStr, startTime, endTime, tz] = match;
  const tzPart = tz ? ` ${tz}` : "";
  const base = `${weekday}, ${month} ${dayStr}, ${yearStr} at ${startTime}${tzPart}`;
  const startIso = parseDateFromText(base);
  let endIso = null;
  if (endTime) {
    const endBase = `${weekday}, ${month} ${dayStr}, ${yearStr} at ${endTime}${tzPart}`;
    endIso = parseDateFromText(endBase);
    if (startIso && endIso) {
      const startDate = new Date(startIso);
      const endDate = new Date(endIso);
      if (endDate < startDate) {
        endDate.setDate(endDate.getDate() + 1);
        endIso = endDate.toISOString();
      }
    }
  }
  const remainder = text.replace(full, "").trim();
  return { startIso, endIso, remainder };
}

const LOGIN_TEXT_PATTERN = /log in|sign up|see posts|facebook|login or sign up to view/i;

function extractFacebookEventId(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/events\/(\d+)/);
    if (match) return match[1];
  } catch {
    // ignore, try fallback below
  }
  const fallback = String(url).match(/facebook\.com\/events\/(\d+)/i);
  return fallback ? fallback[1] : null;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toJSDate === "function") {
    const jsDate = value.toJSDate();
    if (jsDate instanceof Date && !Number.isNaN(jsDate.getTime())) {
      return jsDate.toISOString();
    }
  }
  return null;
}

function cleanText(value, limit = 800) {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? text.slice(0, limit).trim() : text;
}

async function fetchFacebookIcsDetails(url, log) {
  const eventId = extractFacebookEventId(url);
  if (!eventId) return null;
  const icsUrl = `https://www.facebook.com/events/${eventId}/export`;
  try {
    const res = await http.get(icsUrl, { responseType: "text" });
    await polite(150, 350);
    const data = ical.parseICS(res.data);
    const event = Object.values(data).find((entry) => entry && entry.type === "VEVENT");
    if (!event) return null;

    const starts_at = toIso(event.start);
    const ends_at = toIso(event.end);
    const title = cleanText(event.summary, 200);
    const description = cleanText(event.description, 1200);
    const location = cleanText(event.location, 400);

    let venue = null;
    let city = null;
    if (location) {
      const parts = location.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
      if (parts.length) {
        venue = parts.shift();
        if (parts.length) {
          city = parts.join(", ");
        }
      } else {
        venue = location;
      }
    }

    return {
      title,
      description,
      start_time: starts_at,
      end_time: ends_at,
      venue,
      city,
      url: event.url || url,
    };
  } catch (error) {
    log?.debug?.("Facebook ICS fetch failed", error);
    return null;
  }
}

function mergeIcsData(merged, icsData) {
  if (!icsData) return merged;
  if (icsData.title && (!merged.title || LOGIN_TEXT_PATTERN.test(merged.title))) {
    merged.title = icsData.title;
  }
  if (icsData.description && (!merged.description || LOGIN_TEXT_PATTERN.test(merged.description))) {
    merged.description = icsData.description;
  }
  if (icsData.start_time && !merged.start_time) {
    merged.start_time = icsData.start_time;
  }
  if (icsData.end_time && !merged.end_time) {
    merged.end_time = icsData.end_time;
  }
  if (icsData.venue && (!merged.venue || LOGIN_TEXT_PATTERN.test(merged.venue) || merged.venue.length > icsData.venue.length)) {
    merged.venue = cleanLocation(icsData.venue, 160);
  }
  if (icsData.city && (!merged.city || LOGIN_TEXT_PATTERN.test(merged.city) || merged.city.length > icsData.city.length)) {
    merged.city = cleanLocation(icsData.city, 120);
  }
  if (icsData.url && (!merged.url || LOGIN_TEXT_PATTERN.test(merged.url))) {
    merged.url = icsData.url;
  }
  return merged;
}

export async function scrapeFacebookEvent(url, options = {}) {
  const log = logger;
  const headless = options.headless ?? true;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  let prefill = {};
  try {
    prefill = await fetchOpenGraph(url);
  } catch (error) {
    log.warn("OpenGraph fetch failed", error);
    prefill = {};
  }

  const icsPrefill = await fetchFacebookIcsDetails(url, log);

  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ],
      chromiumSandbox: false
    });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent:
        options.userAgent ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      locale: "en-US",
    });

    const page = await context.newPage();
    await page.goto(url, { timeout, waitUntil: "domcontentloaded" });

    let selectorHit = false;
    for (const selector of EVENT_SELECTORS) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        selectorHit = true;
        break;
      } catch {
        // ignore and try next selector
      }
    }

    await hideLoginOverlays(page);

    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // ignore networkidle timeouts; dynamic pages often keep connections alive
    }

    let html = await page.content();
    let eventVisible = selectorHit;
    if (!eventVisible) {
      eventVisible = await hasEventContent(page);
    }

    let loginWall = isProbablyLoginWall(html);
    if (loginWall && !eventVisible) {
      const mobileUrl = toMobileUrl(url);
      if (mobileUrl !== url) {
        log.warn("Login wall detected; retrying via mobile site", { url });
        await page.goto(mobileUrl, { timeout, waitUntil: "domcontentloaded" });
        await hideLoginOverlays(page);
        try {
          await page.waitForLoadState("networkidle", { timeout: 5000 });
        } catch {
          // ignore networkidle failures
        }
        html = await page.content();
        eventVisible = await hasEventContent(page);
        loginWall = isProbablyLoginWall(html);
      }
      if (loginWall && !eventVisible) {
        log.warn("Facebook displayed a login wall overlay; attempting to parse rendered HTML anyway");
      }
    }

    const domPrefill = parseOpenGraphFromHtml(html, url);
    const fallbacks = await collectFallbacks(page);
    log.debug?.('Facebook open graph prefill', prefill);
    log.debug?.('Facebook DOM prefill', domPrefill);
    log.debug?.('Facebook fallback scrape', fallbacks);
    log.debug?.('Facebook ICS prefill', icsPrefill);
    const merged = normaliseResult({ ...prefill, ...domPrefill }, fallbacks);

    const rangeFromStartText = parseDateRangeString(fallbacks.start_time_text);
    if (!merged.start_time && rangeFromStartText?.startIso) {
      merged.start_time = rangeFromStartText.startIso;
    }
    if (!merged.end_time && rangeFromStartText?.endIso) {
      merged.end_time = rangeFromStartText.endIso;
    }

    if (!merged.title || LOGIN_TEXT_PATTERN.test(merged.title)) {
      let pageTitle = null;
      try {
        pageTitle = await page.title();
      } catch {
        pageTitle = null;
      }
      if (pageTitle) {
        merged.title = pageTitle.replace(/\s*\|\s*Facebook$/i, "").trim();
      }
    }

    const rangeFromLocation = parseDateRangeString(fallbacks.raw_location_text);
    if (rangeFromLocation) {
      if (!merged.start_time && rangeFromLocation.startIso) {
        merged.start_time = rangeFromLocation.startIso;
      }
      if (!merged.end_time && rangeFromLocation.endIso) {
        merged.end_time = rangeFromLocation.endIso;
      }
      if (rangeFromLocation.remainder) {
        const segments = rangeFromLocation.remainder
          .split(/\n+|\s{2,}|,\s*/)
          .map((part) => part.trim())
          .filter(Boolean);
        if (segments.length) {
          const candidateVenue = segments[0];
          const candidateCity = segments.slice(1).join(", ") || null;
          if (candidateVenue && (!fallbacks.venue || candidateVenue.length < fallbacks.venue.length)) {
            fallbacks.venue = candidateVenue;
          }
          if (candidateCity && (!fallbacks.city || candidateCity.length < fallbacks.city.length)) {
            fallbacks.city = candidateCity;
          }
        }
      }
    }

    if (!merged.start_time && fallbacks.start_time_iso) {
      const iso = safeIso(fallbacks.start_time_iso);
      if (iso) merged.start_time = iso;
    }
    if (!merged.end_time && fallbacks.end_time_iso) {
      const iso = safeIso(fallbacks.end_time_iso);
      if (iso) merged.end_time = iso;
    }
    if (!merged.start_time && fallbacks.start_time_text) {
      const parsed = parseDateFromText(fallbacks.start_time_text);
      if (parsed) {
        merged.start_time = parsed;
      }
    }
    if (!merged.end_time && fallbacks.end_time_text) {
      const parsed = parseDateFromText(fallbacks.end_time_text);
      if (parsed) {
        merged.end_time = parsed;
      }
    }

    if (fallbacks.venue) {
      const cleanedVenue = cleanLocation(fallbacks.venue, 160);
      if (cleanedVenue && (!merged.venue || /facebook/i.test(merged.venue))) {
        merged.venue = cleanedVenue;
      }
    }

    if (fallbacks.city) {
      const cleanedCity = cleanLocation(fallbacks.city, 120);
      if (
        cleanedCity &&
        (!merged.city || merged.city.length > cleanedCity.length || /facebook/i.test(merged.city))
      ) {
        merged.city = cleanedCity;
      }
    }

    if (merged.venue) {
      const cleaned = cleanLocation(merged.venue, 160);
      if (cleaned) merged.venue = cleaned;
    }

    if (merged.city) {
      const cleaned = cleanLocation(merged.city, 120);
      if (cleaned) merged.city = cleaned;
    }

    mergeIcsData(merged, icsPrefill);

    if (!merged.title) {
      throw new Error("Failed to read event title from Facebook page");
    }

    return merged;
  } catch (error) {
    if (icsPrefill) {
      log.warn("Facebook scrape failed; returning ICS-derived data", error);
      return mergeIcsData({}, icsPrefill);
    }
    if (Object.keys(prefill).length) {
      log.warn("Facebook scrape failed; returning OpenGraph data", error);
      return prefill;
    }
    log.error("Facebook scrape failed", error);
    throw error;
  } finally {
    await browser?.close();
  }
}

export default scrapeFacebookEvent;
