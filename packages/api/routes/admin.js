import { Router } from "express";
import { fetchIcs } from "../../scraper/ics.js";
import { fetchOpenGraph } from "../../scraper/og.js";
import { scrapeFacebookEvent } from "../../scraper/facebook-event.js";
import { upsertEvents } from "../../scraper/db.js";
import { contentHash } from "../../scraper/scrape-helpers.js";
import logger from "../../scraper/logger.js";
import { escapeHtml } from "../lib/html.js";

function shorten(text, max = 60) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderCoverageRows(rows) {
  return rows
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.source)}</td>
        <td>${escapeHtml(r.total)}</td>
        <td>${escapeHtml(r.missing_start)}</td>
        <td>${escapeHtml(r.missing_image)}</td>
        <td>${escapeHtml(r.missing_desc)}</td>
        <td>${renderLatestCell(r)}</td>
      </tr>`
    )
    .join("");
}

function renderLatestCell(row) {
  if (!row.sample_url) return "<span class=\"small\">—</span>";
  const parts = [
    `<a href="${escapeHtml(row.sample_url)}" target="_blank" rel="noreferrer">Open</a>`
  ];
  const label = shorten(row.sample_url, 80);
  parts.push(`<div class=\"small truncate\" title="${escapeHtml(row.sample_url)}">${escapeHtml(label)}</div>`);
  if (row.sample_title) {
    parts.push(`<div class=\"small\">${escapeHtml(row.sample_title)}</div>`);
  }
  if (row.sample_starts_at) {
    parts.push(`<div class=\"small\">${escapeHtml(row.sample_starts_at)}</div>`);
  }
  return `<div>${parts.join("")}</div>`;
}

function renderFeedsRows(feeds) {
  return feeds
    .map(
      (f) => `
      <tr>
        <td>${escapeHtml(f.id)}</td>
        <td>${escapeHtml(f.label ?? "")}</td>
        <td>${escapeHtml(f.url)}</td>
        <td>${escapeHtml(f.active)}</td>
        <td>${escapeHtml(f.last_fetch_at ?? "")}</td>
        <td>${escapeHtml(f.last_status ?? "")}</td>
        <td>
          <button onclick='ingestIcs(${JSON.stringify(f.url)}, ${JSON.stringify(f.label ?? "")})'>
            Ingest Now
          </button>
        </td>
      </tr>`
    )
    .join("");
}

function renderLinksRows(links) {
  return links
    .map(
      (l) => `
      <tr>
        <td>${escapeHtml(l.id)}</td>
        <td>
          <a class="truncate" title="${escapeHtml(l.url)}" href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer">
            ${escapeHtml(shorten(l.url, 80))}
          </a>
        </td>
        <td>${escapeHtml(l.last_checked_at ?? "")}</td>
        <td>${escapeHtml(l.last_status ?? "")}</td>
      </tr>`
    )
    .join("");
}

function isFacebookEventUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return (
      (hostname === "facebook.com" || hostname.endsWith(".facebook.com")) &&
      /^\/events\//.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function renderManualEventsRows(events) {
  if (!events.length)
    return `<tr><td colspan="6" class="small">No manual Facebook events saved yet.</td></tr>`;
  return events
    .map(
      (event) => `
        <tr>
          <td>${escapeHtml(event.id)}</td>
          <td>${escapeHtml(event.title ?? "")}</td>
          <td>${escapeHtml(event.starts_at ?? "")}</td>
          <td>${escapeHtml(event.venue ?? "")}</td>
          <td>${escapeHtml(event.city ?? "")}</td>
          <td><a class="truncate" title="${escapeHtml(event.url)}" href="${escapeHtml(event.url)}" target="_blank" rel="noreferrer">${escapeHtml(shorten(event.url, 80))}</a></td>
        </tr>`
    )
    .join("");
}

function renderAdminPage({ coverage, feeds, links, manualEvents }) {
  return `<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Admin</title>
    <style>
      body{font-family:ui-sans-serif,system-ui; padding:16px; max-width:1100px; margin:auto}
      table{border-collapse:collapse; width:100%; margin:12px 0}
      th,td{border:1px solid #ddd; padding:6px; font-size:14px; word-break:break-word}
      th{background:#f6f6f6}
      input,button{padding:8px; font-size:14px}
      form{display:grid; gap:8px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); align-items:center}
      form > button{justify-self:end}
      .card{border:1px solid #e3e3e3; padding:12px; border-radius:8px; margin:12px 0}
      textarea{width:100%; min-height:90px}
      .small{font-size:12px; color:#666}
      .truncate{display:inline-block; max-width:230px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom}
      .spinner{display:inline-block;width:14px;height:14px;border:2px solid #d0d0d0;border-top-color:#333;border-radius:50%;animation:spin 0.7s linear infinite;margin-left:8px;vertical-align:middle;visibility:hidden}
      @keyframes spin{to{transform:rotate(360deg)}}
    </style>
    <h1>Admin</h1>

    <h2>Coverage</h2>
    <table>
      <thead><tr><th>Source</th><th>Total</th><th>Missing Start</th><th>Missing Image</th><th>Missing Desc</th><th>Latest Event</th></tr></thead>
      <tbody>${renderCoverageRows(coverage)}</tbody>
    </table>
    <div class="small">Click “Open” to view the most recently stored event for that source.</div>

    <div class="card">
      <h2>Add ICS Feed</h2>
      <form id="icsForm" onsubmit="return false;">
        <input name="label" placeholder="Label (e.g., 'City Arts Council')"/>
        <input name="url" placeholder="https://.../calendar.ics" required/>
        <button onclick="addIcs()">Add</button>
      </form>
      <div class="small">You can also click “Ingest Now” to pull immediately.</div>
      <table>
        <thead><tr><th>ID</th><th>Label</th><th>URL</th><th>Active</th><th>Last Fetch</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${renderFeedsRows(feeds)}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Manual / Facebook Events</h2>
      <div class="small">Recently saved events added via the Facebook scraper or manual form.</div>
      <table>
        <thead><tr><th>ID</th><th>Title</th><th>Start</th><th>Venue</th><th>City</th><th>URL</th></tr></thead>
        <tbody>${renderManualEventsRows(manualEvents)}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Add Event by URL (Facebook or any site)</h2>
      <form id="linkForm" onsubmit="return false;">
        <input name="url" placeholder="https://..." required/>
        <button id="prefillBtn" type="button" onclick="prefill()">Prefill</button>
        <span id="prefillSpinner" class="spinner" aria-hidden="true"></span>
      </form>
      <div id="prefillBox" style="display:none; margin-top:12px;">
        <h3>Prefill Result</h3>
        <div style="display:grid; gap:8px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr));">
          <input id="title" placeholder="Title"/>
          <input id="starts_at" placeholder="Start (YYYY-MM-DDTHH:MM:SSZ)"/>
          <input id="ends_at" placeholder="End (optional)"/>
          <input id="venue" placeholder="Venue (optional)"/>
          <input id="city" placeholder="City (optional)"/>
          <input id="image_url" placeholder="Image URL (optional)"/>
          <input id="tags" placeholder="Tags (CSV, optional)"/>
          <input id="tickets_url" placeholder="Tickets URL (optional)"/>
        </div>
        <textarea id="description" placeholder="Description (optional)"></textarea>
        <div style="margin-top:8px;">
          <button onclick="saveManual()">Save Event</button>
        </div>
      </div>

      <h3>Recently Added Links</h3>
      <table>
        <thead><tr><th>ID</th><th>URL</th><th>Last Checked</th><th>Status</th></tr></thead>
        <tbody>${renderLinksRows(links)}</tbody>
      </table>
    </div>

    <script>
      async function addIcs(){
        const fd = new FormData(document.getElementById('icsForm'));
        const body = Object.fromEntries(fd.entries());
        const res = await fetch('/admin/ics', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        if (!res.ok) return alert('Failed to add ICS');
        alert('ICS added. You can ingest it immediately via the table.');
        location.reload();
      }
      async function ingestIcs(url,label){
        const body = { url, label };
        const res = await fetch('/admin/ics/ingest', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const j = await res.json();
        alert(res.ok ? ('Ingested '+j.count+' events') : ('Failed: '+(j.error||res.status)));
        location.reload();
      }
      async function prefill(){
        const btn = document.getElementById('prefillBtn');
        const spinner = document.getElementById('prefillSpinner');
        const fd = new FormData(document.getElementById('linkForm'));
        const url = fd.get('url');
        btn.disabled = true;
        spinner.style.visibility = 'visible';
        try {
          const res = await fetch('/admin/link/prefill', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url }) });
          const j = await res.json();
          if (!res.ok) {
            alert(j.error||'Prefill failed');
            return;
          }
          document.getElementById('prefillBox').style.display='block';
          document.getElementById('prefillBox').dataset.url = url;
          const p = j.prefill || {};
          document.getElementById('title').value = p.title || '';
          document.getElementById('image_url').value = p.image_url || '';
          document.getElementById('description').value = p.description || '';
          document.getElementById('starts_at').value = p.start_time || '';
          document.getElementById('ends_at').value = p.end_time || '';
          document.getElementById('venue').value = p.venue || '';
          document.getElementById('city').value = p.city || '';
          document.getElementById('tickets_url').value = p.tickets_url || '';
        } catch (e) {
          console.error('Prefill failed', e);
          alert('Prefill failed');
        } finally {
          btn.disabled = false;
          spinner.style.visibility = 'hidden';
        }
      }
      async function saveManual(){
        const url = document.getElementById('prefillBox').dataset.url;
        const body = {
          url,
          title: document.getElementById('title').value,
          starts_at: document.getElementById('starts_at').value || null,
          ends_at: document.getElementById('ends_at').value || null,
          venue: document.getElementById('venue').value || null,
          city: document.getElementById('city').value || null,
          image_url: document.getElementById('image_url').value || null,
          description: document.getElementById('description').value || null,
          tickets_url: document.getElementById('tickets_url').value || null,
          tags: document.getElementById('tags').value || ''
        };
        const res = await fetch('/admin/link/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const j = await res.json();
        alert(res.ok ? 'Saved' : ('Failed: '+(j.error||res.status)));
        location.reload();
      }
    </script>`;
}

export function createAdminRouter(db) {
  const router = Router();

  router.get("/", (_req, res) => {
    const coverage = db
      .prepare(
        `
        WITH ranked AS (
          SELECT
            source,
            title,
            url,
            starts_at,
            image_url,
            description,
            updated_at,
            id,
            ROW_NUMBER() OVER (
              PARTITION BY source
              ORDER BY COALESCE(starts_at, '') DESC, updated_at DESC, id DESC
            ) AS rn
          FROM events
        )
        SELECT
          source,
          COUNT(*) AS total,
          SUM(starts_at IS NULL) AS missing_start,
          SUM(image_url IS NULL) AS missing_image,
          SUM(description IS NULL) AS missing_desc,
          MAX(CASE WHEN rn = 1 THEN url END) AS sample_url,
          MAX(CASE WHEN rn = 1 THEN title END) AS sample_title,
          MAX(CASE WHEN rn = 1 THEN starts_at END) AS sample_starts_at
        FROM ranked
        GROUP BY source
        ORDER BY source ASC
      `
      )
      .all();

    const feeds = db.prepare("SELECT * FROM ics_sources ORDER BY id DESC").all();
    const links = db.prepare("SELECT * FROM event_links ORDER BY id DESC LIMIT 100").all();
    const manualEvents = db
      .prepare(
        `
        SELECT id, title, starts_at, venue, city, url
        FROM events
        WHERE source = 'manual'
        ORDER BY updated_at DESC
        LIMIT 50
      `
      )
      .all();

    res
      .type("html")
      .send(renderAdminPage({ coverage, feeds, links, manualEvents }));
  });

  router.get("/sources.json", (_req, res) => {
    const feeds = db.prepare("SELECT * FROM ics_sources ORDER BY id DESC").all();
    const links = db.prepare("SELECT * FROM event_links ORDER BY id DESC LIMIT 200").all();
    res.json({ feeds, links });
  });

  router.post("/ics", (req, res) => {
    const { url, label } = req.body || {};
    if (!url) return res.status(400).json({ error: "url required" });
    try {
      db.prepare(
        `
        INSERT INTO ics_sources (url, label, active, last_status)
        VALUES (@url, @label, 1, 'added')
        ON CONFLICT(url) DO UPDATE SET label=excluded.label
      `
      ).run({ url, label });
      res.json({ ok: true });
    } catch (e) {
      logger.error("Failed to add ICS source:", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/ics/ingest", async (req, res) => {
    const { url, label, city } = req.body || {};
    if (!url) return res.status(400).json({ error: "url required" });
    try {
      const rows = await fetchIcs(url, label, city);
      if (rows.length) upsertEvents(db, rows);
      db.prepare(
        `
        UPDATE ics_sources
        SET last_fetch_at = datetime('now'), last_status = @status
        WHERE url = @url
      `
      ).run({ url, status: `ok:${rows.length}` });
      res.json({ ok: true, count: rows.length });
    } catch (e) {
      db.prepare(
        `
        UPDATE ics_sources
        SET last_fetch_at = datetime('now'), last_status = @status
        WHERE url = @url
      `
      ).run({ url, status: `error:${String(e).slice(0, 200)}` });
      logger.error("ICS ingest failed:", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/link/prefill", async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "url required" });
    try {
      let prefill;
      if (isFacebookEventUrl(url)) {
        try {
          prefill = await scrapeFacebookEvent(url);
          logger.debug("Facebook prefill result", prefill);
        } catch (err) {
          logger.warn("Playwright scrape failed, falling back to OpenGraph", err);
          prefill = await fetchOpenGraph(url);
          logger.debug("OpenGraph fallback result", prefill);
        }
      } else {
        prefill = await fetchOpenGraph(url);
      }
      db.prepare(
        `
        INSERT INTO event_links (url, last_checked_at, last_status)
        VALUES (@url, datetime('now'), 'prefill')
        ON CONFLICT(url) DO UPDATE SET last_checked_at=datetime('now'), last_status='prefill'
      `
      ).run({ url });
      res.json({ ok: true, prefill });
    } catch (e) {
      logger.error("Prefill failed:", e);
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/link/save", (req, res) => {
  const { url, title, starts_at, ends_at, venue, city, image_url, description, tickets_url, tags } = req.body || {};
    if (!url || !title) return res.status(400).json({ error: "url and title required" });

    const row = {
      source: "manual",
      source_id: url,
      title: String(title).trim(),
      starts_at: starts_at || null,
      ends_at: ends_at || null,
      venue: venue || null,
      city: city || null,
      url,
      image_url: image_url || null,
    description: description || null,
    tags: tags || "",
  };
  if (tickets_url) {
    const ticketLine = `Tickets: ${tickets_url}`;
    row.description = row.description ? `${row.description}\n${ticketLine}` : ticketLine;
  }
    row.content_hash = contentHash(row);

    try {
      upsertEvents(db, [row]);
      db.prepare("UPDATE event_links SET last_status='saved', last_checked_at=datetime('now') WHERE url=@url").run({ url });
      res.json({ ok: true });
    } catch (e) {
      logger.error("Manual save failed:", e);
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}

export default createAdminRouter;
