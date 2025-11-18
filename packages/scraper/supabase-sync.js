import crypto from "node:crypto";
import logger from "./logger.js";
import { getSupabaseClient, hasSupabaseConfig } from "./supabase-client.js";

const UPSERT_CHUNK_SIZE = 200;

const TAG_SPLIT_REGEX = /[,/|]/;

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function stableHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function buildExternalId(prefix, ...parts) {
  const joined = parts
    .filter(Boolean)
    .map(part => part.trim().toLowerCase())
    .join("::");
  if (!joined) return null;
  return `${prefix}_${stableHash(joined)}`;
}

function normalizeText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function parseTags(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : String(raw).split(TAG_SPLIT_REGEX);
  const seen = new Set();
  const list = [];
  for (const value of values) {
    const text = normalizeText(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(text);
  }
  return list;
}

function inferDateFromSlug(value) {
  if (!value) return null;
  const match = String(value).match(/(\d{4})-(\d{2})-(\d{2})(?:[-_T]?(\d{3,4}))?(?:[-_]?([ap]m))?/i);
  if (!match) return null;
  const [, year, month, day, timeDigits = "", meridiemRaw = ""] = match;
  let hours = 0;
  let minutes = 0;
  if (timeDigits) {
    const padded = timeDigits.padStart(4, "0").slice(-4);
    hours = Number.parseInt(padded.slice(0, 2), 10) || 0;
    minutes = Number.parseInt(padded.slice(2), 10) || 0;
  }
  const meridiem = meridiemRaw.toLowerCase();
  if (meridiem === "pm" && hours < 12) {
    hours += 12;
  } else if (meridiem === "am" && hours === 12) {
    hours = 0;
  }
  const hourStr = String(hours).padStart(2, "0");
  const minuteStr = String(minutes).padStart(2, "0");
  return `${year}-${month}-${day}T${hourStr}:${minuteStr}:00`;
}

function deriveEventDate(row) {
  return row.starts_at || row.ends_at || inferDateFromSlug(row.source_id || row.url || row.title || "") || null;
}

function normalizeRows(rows) {
  const venues = new Map();
  const organizers = new Map();
  const tags = new Map();
  const events = [];
  const countsBySource = new Map();

  for (const row of rows) {
    const source = row.source || "unknown";
    countsBySource.set(source, (countsBySource.get(source) ?? 0) + 1);

    const title = normalizeText(row.title) || "Untitled Event";
    const description = normalizeText(row.description);
    const date = deriveEventDate(row);
    const endDate = row.ends_at ?? null;
    const url = row.url || row.source_id || null;
    const imageUrl = row.image_url || null;
    const price = row.price ?? null;
    const sourceId = row.source_id || url || buildExternalId("src", source, title);
    const externalId = buildExternalId("event", source, sourceId || title);
    if (!externalId) continue;

    const venueName = normalizeText(row.venue);
    const city = normalizeText(row.city);
    const venueKey = venueName ? buildExternalId("venue", source, venueName, city || "") : null;
    if (venueKey && !venues.has(venueKey)) {
      venues.set(venueKey, {
        external_id: venueKey,
        name: venueName,
        city,
      });
    }

    const organizerName = normalizeText(row.organizer);
    const organizerKey = organizerName ? buildExternalId("organizer", source, organizerName) : null;
    if (organizerKey && !organizers.has(organizerKey)) {
      organizers.set(organizerKey, {
        external_id: organizerKey,
        name: organizerName,
      });
    }

    const tagValues = parseTags(row.tags);
    const tagKeys = [];
    for (const tagName of tagValues) {
      const slug = slugify(tagName) || stableHash(tagName).slice(0, 12);
      const tagExternalId = buildExternalId("tag", slug);
      if (!tags.has(tagExternalId)) {
        tags.set(tagExternalId, {
          external_id: tagExternalId,
          name: tagName,
          slug,
        });
      }
      tagKeys.push(tagExternalId);
    }

    events.push({
      external_id: externalId,
      source,
      source_id: sourceId,
      title,
      description,
      date,
      end_date: endDate,
      url,
      image_url: imageUrl,
      price,
      venue_key: venueKey,
      organizer_key: organizerKey,
      tag_keys: tagKeys,
    });
  }

  return {
    events,
    venues: Array.from(venues.values()),
    organizers: Array.from(organizers.values()),
    tags: Array.from(tags.values()),
    countsBySource,
  };
}

async function upsertEntities(client, table, rows, { onConflict = "external_id" } = {}) {
  if (!rows.length) return new Map();
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await client.from(table).upsert(chunk, { onConflict });
    if (error) {
      throw new Error(`[supabase] Failed to upsert ${table}: ${error.message}`);
    }
  }
  const externalIds = rows.map(r => r.external_id).filter(Boolean);
  if (!externalIds.length) return new Map();
  const { data, error } = await client
    .from(table)
    .select("id,external_id")
    .in("external_id", externalIds);
  if (error) {
    throw new Error(`[supabase] Failed to read ${table} ids: ${error.message}`);
  }
  const map = new Map();
  for (const row of data ?? []) {
    map.set(row.external_id, row.id);
  }
  return map;
}

async function syncEventTags(client, normalizedEvents, eventIds, tagIds) {
  if (!eventIds.size) return;
  const tagRows = [];
  const touchedEvents = new Set();

  for (const event of normalizedEvents) {
    const eventId = eventIds.get(event.external_id);
    if (!eventId) continue;
    touchedEvents.add(eventId);
    const seen = new Set();
    for (const tagKey of event.tag_keys) {
      const tagId = tagIds.get(tagKey);
      if (!tagId || seen.has(tagId)) continue;
      seen.add(tagId);
      tagRows.push({ event_id: eventId, tag_id: tagId });
    }
  }

  if (touchedEvents.size) {
    const ids = [...touchedEvents];
    const { error: delError } = await client.from("event_tags").delete().in("event_id", ids);
    if (delError) {
      throw new Error(`[supabase] Failed to reset event_tags: ${delError.message}`);
    }
  }

  if (!tagRows.length) return;
  for (let i = 0; i < tagRows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = tagRows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await client.from("event_tags").upsert(chunk, { onConflict: "event_id,tag_id" });
    if (error) {
      throw new Error(`[supabase] Failed to upsert event_tags: ${error.message}`);
    }
  }
}

async function pruneSupabaseEvents(client, normalizedEvents) {
  const bySource = new Map();
  for (const event of normalizedEvents) {
    if (!event.source) continue;
    if (!bySource.has(event.source)) bySource.set(event.source, new Set());
    bySource.get(event.source).add(event.external_id);
  }

  for (const [source, keep] of bySource.entries()) {
    const { data, error } = await client
      .from("events")
      .select("id,external_id")
      .eq("source", source);
    if (error) {
      throw new Error(`[supabase] Failed to load existing events for ${source}: ${error.message}`);
    }
    if (!data?.length) continue;
    const stale = data.filter(row => !keep.has(row.external_id));
    if (!stale.length) continue;
    const staleIds = stale.map(row => row.id);
    const { error: delTagsError } = await client.from("event_tags").delete().in("event_id", staleIds);
    if (delTagsError) {
      throw new Error(`[supabase] Failed to clean event_tags for ${source}: ${delTagsError.message}`);
    }
    const { error: delEventsError } = await client.from("events").delete().in("id", staleIds);
    if (delEventsError) {
      throw new Error(`[supabase] Failed to delete stale ${source} events: ${delEventsError.message}`);
    }
    logger.info(`[supabase] Pruned ${staleIds.length} stale events for source ${source}`);
  }
}

export async function syncRowsToSupabase(rows) {
  if (!hasSupabaseConfig()) {
    logger.warn("Supabase credentials missing; skipping Supabase sync.");
    return;
  }
  const client = getSupabaseClient();
  const normalized = normalizeRows(rows);
  if (!normalized.events.length) {
    logger.info("[supabase] No events to sync.");
    return;
  }

  const venueIds = await upsertEntities(client, "venues", normalized.venues);
  const organizerIds = await upsertEntities(client, "organizers", normalized.organizers);
  const tagIds = await upsertEntities(client, "tags", normalized.tags, { onConflict: "external_id" });

  const eventsPayload = normalized.events.map(event => ({
    external_id: event.external_id,
    source_id: event.source_id,
    source: event.source,
    title: event.title,
    description: event.description,
    date: event.date,
    end_date: event.end_date,
    url: event.url,
    image_url: event.image_url,
    price: event.price,
    venue_id: event.venue_key ? venueIds.get(event.venue_key) ?? null : null,
    organizer_id: event.organizer_key ? organizerIds.get(event.organizer_key) ?? null : null,
  }));

  const eventIds = await upsertEntities(client, "events", eventsPayload);
  await syncEventTags(client, normalized.events, eventIds, tagIds);
  await pruneSupabaseEvents(client, normalized.events);

  const summary = [...normalized.countsBySource.entries()]
    .map(([source, count]) => `${source}=${count}`)
    .join(", ");
  logger.info(`[supabase] Synced ${normalized.events.length} events (${summary})`);
}
