import * as cheerio from "cheerio";
import vm from "node:vm";
import { http, polite } from "../net.js";
import { absoluteUrl, contentHash } from "../scrape-helpers.js";
import { normalizeText } from "../dom-utils.js";
import logger from "../logger.js";

const BASE = "https://artsandculturecentre.com";
const ST_JOHNS_BASE = `${BASE}/stjohns/online/`;
const LISTING_URL = `${ST_JOHNS_BASE}default.asp`;
const SOURCE = "artsandculturecentre";
const TIME_ZONE = "America/St_Johns";
const SKIP_ENRICH = process.env.SCRAPER_SKIP_ENRICH === "1";

const FIELD_NAMES = [
  "id", "object_type", "type", "category", "name", "description", "short_description",
  "start_date", "start_date_time", "start_date_date", "start_date_month", "start_date_year",
  "end_date", "on_sale_date", "sales_status", "availability_status", "availability_num",
  "keywords", "additional_info", "group", "image1", "image2", "image1_alt_text",
  "image2_alt_text", "thumbnail", "app_image", "data1", "data2", "data3", "data4",
  "data5", "data6", "data7", "data8", "data9", "data10", "data11", "data12",
  "data13", "data14", "data15", "data16", "filter1", "filter2", "filter3",
  "filter4", "filter_parent1", "filter_child2", "filter_parent2", "filter_child1",
  "multifilter1", "multifilter2", "organization_short_description", "sales_type",
  "options", "street", "city", "state", "zip", "country", "longitude", "latitude",
  "venue_id", "venue_name", "venue_description", "venue_short_description",
  "venue_group", "venue_data1", "venue_data2", "venue_data3", "venue_data4",
  "venue_data5", "venue_data6", "venue_data7", "venue_data8", "venue_data9",
  "venue_data10", "venue_data11", "venue_data12", "venue_type", "series_name",
  "min_price", "max_price", "upsell_article_id", "addon_article_id", "email",
  "e_address1", "e_address2", "e_address3", "customer_id", "tracking_code",
  "twitter_search_term", "external_reference_code", "access", "organization_id",
  "meta_description"
];

function clean(value) {
  return normalizeText(
    String(value ?? "")
      .replace(/&nbsp;/g, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function extractArticleContext(html) {
  const marker = "var articleContext = ";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const end = html.indexOf("\n\ncreateSearchMapping(articleContext)", start);
  if (end === -1) return null;
  const source = html.slice(start + marker.length, end).replace(/;\s*$/, "");
  try {
    return vm.runInNewContext(`(${source})`, {}, { timeout: 1000 });
  } catch (error) {
    logger.warn("Arts and Culture Centre: failed to parse articleContext:", error?.message ?? error);
    return null;
  }
}

function rowToObject(row) {
  return Object.fromEntries(FIELD_NAMES.map((name, index) => [name, row[index]]));
}

function extractArticleImage(html, articleRow) {
  const $ = cheerio.load(html);
  const detailImage = $("#event-details img").first().attr("src");
  return absoluteUrl(BASE, detailImage || articleRow?.image1 || articleRow?.image2 || null);
}

function getTimeZoneOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return asUtc - date.getTime();
}

function zonedDateTimeToIso({ year, monthIndex, day, time }) {
  const y = Number.parseInt(year, 10);
  const m = Number.parseInt(monthIndex, 10);
  const d = Number.parseInt(day, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;

  const [hourRaw = "0", minuteRaw = "0"] = String(time || "00:00").split(":");
  const hour = Number.parseInt(hourRaw, 10) || 0;
  const minute = Number.parseInt(minuteRaw, 10) || 0;
  const localAsUtc = Date.UTC(y, m, d, hour, minute, 0, 0);
  let utc = localAsUtc - getTimeZoneOffsetMs(TIME_ZONE, new Date(localAsUtc));
  utc = localAsUtc - getTimeZoneOffsetMs(TIME_ZONE, new Date(utc));
  const parsed = new Date(utc);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function performanceStartIso(row) {
  return zonedDateTimeToIso({
    year: row.start_date_year,
    monthIndex: row.start_date_month,
    day: row.start_date_date,
    time: row.start_date_time
  });
}

function formatPrice(row) {
  const min = clean(row.min_price);
  const max = clean(row.max_price);
  if (min && max && min !== max) return `${min} - ${max}`;
  return min || max || null;
}

function isStJohnsPerformance(row) {
  const city = clean(row.city)?.toLowerCase();
  const state = clean(row.state)?.toUpperCase();
  const venueGroup = clean(row.venue_group)?.toLowerCase();
  const url = clean(row.additional_info)?.toLowerCase();
  return state === "NL" && (
    city === "st. john's" ||
    venueGroup === "st. johns" ||
    url?.includes("/stjohns/")
  );
}

function buildDetailUrl(articleId) {
  const url = new URL("default.asp", ST_JOHNS_BASE);
  url.searchParams.set("doWork::WScontent::loadArticle", "Load");
  url.searchParams.set("BOparam::WScontent::loadArticle::article_id", articleId);
  return url.toString();
}

async function fetchHtml(url) {
  const res = await http.get(url, {
    responseType: "text",
    timeout: 45000,
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: LISTING_URL
    }
  });
  await polite(250, 450);
  return res.data;
}

function mapPerformance(row, { articleRow, imageUrl }) {
  const eventUrl = absoluteUrl(ST_JOHNS_BASE, row.additional_info) || buildDetailUrl(articleRow.id);
  const title = clean(row.short_description) || clean(articleRow.name) || clean(row.name) || "Untitled Event";
  const city = [clean(row.city), clean(row.state)].filter(Boolean).join(", ") || "St. John's, NL";
  const tags = [
    row.organization_short_description,
    row.data1,
    row.data2,
    row.data3
  ].map(clean).filter(Boolean).join(", ");

  const event = {
    source: SOURCE,
    source_id: clean(row.id) || eventUrl || title,
    title,
    starts_at: performanceStartIso(row),
    ends_at: null,
    venue: clean(row.venue_name) || "St. John's Arts and Culture Centre",
    city,
    url: eventUrl,
    image_url: imageUrl,
    description: clean(row.description),
    price: formatPrice(row),
    tags
  };
  return { ...event, content_hash: contentHash(event) };
}

export async function scrapeArtsAndCultureCentre() {
  const listingHtml = await fetchHtml(LISTING_URL);
  const listingContext = extractArticleContext(listingHtml);
  const articleRows = (listingContext?.searchResults || [])
    .map(rowToObject)
    .filter(row => row.object_type === "A" && clean(row.data3)?.toLowerCase() === "event");

  if (!articleRows.length) return [];

  if (SKIP_ENRICH) {
    return articleRows.map(row => {
      const event = {
        source: SOURCE,
        source_id: clean(row.id),
        title: clean(row.name) || "Untitled Event",
        starts_at: null,
        ends_at: null,
        venue: "St. John's Arts and Culture Centre",
        city: "St. John's, NL",
        url: buildDetailUrl(row.id),
        image_url: absoluteUrl(BASE, row.image1 || row.image2 || null),
        description: clean(row.description),
        price: null,
        tags: clean(row.data1) || ""
      };
      return { ...event, content_hash: contentHash(event) };
    });
  }

  const events = [];
  const seen = new Set();

  for (const articleRow of articleRows) {
    if (!articleRow.id || seen.has(articleRow.id)) continue;
    seen.add(articleRow.id);

    try {
      const detailHtml = await fetchHtml(buildDetailUrl(articleRow.id));
      const detailContext = extractArticleContext(detailHtml);
      const imageUrl = extractArticleImage(detailHtml, articleRow);
      const performances = (detailContext?.searchResults || [])
        .map(rowToObject)
        .filter(row => row.object_type === "P")
        .filter(isStJohnsPerformance);

      for (const performance of performances) {
        events.push(mapPerformance(performance, { articleRow, imageUrl }));
      }
    } catch (error) {
      logger.warn(`Arts and Culture Centre: detail fetch failed for ${articleRow.id}:`, error?.message ?? error);
    }
  }

  logger.info(`Arts and Culture Centre: parsed ${events.length} St. John's performances.`);
  return events;
}

export default scrapeArtsAndCultureCentre;
