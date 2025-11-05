import { escapeHtml } from "../lib/html.js";

export function createDebugHandler(db) {
  return (_req, res) => {
    const rows = db
      .prepare(
        `
        SELECT id, source, title, starts_at, venue, url
        FROM events
        ORDER BY datetime(starts_at) ASC
        LIMIT 200
      `
      )
      .all();

    const tr = rows
      .map(
        (r) => `
        <tr>
          <td>${escapeHtml(r.id)}</td>
          <td>${escapeHtml(r.source)}</td>
          <td>${escapeHtml(r.title)}</td>
          <td>${escapeHtml(r.starts_at ?? "")}</td>
          <td>${escapeHtml(r.venue ?? "")}</td>
          <td><a href="${escapeHtml(r.url ?? "")}" target="_blank">link</a></td>
        </tr>`
      )
      .join("");

    res
      .type("html")
      .send(`<!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Events (debug)</title>
        <style>
          body{font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:16px}
          table{border-collapse: collapse; width:100%}
          th,td{border:1px solid #ddd; padding:8px; font-size:14px}
          th{background:#f5f5f5; text-align:left; position:sticky; top:0}
          tr:nth-child(even){background:#fafafa}
        </style>
        <h1>Events (first 200)</h1>
        <p>Try the JSON API at <code>/events</code> and filters like
          <code>?source=majestic</code>, <code>?q=market</code>,
          <code>?from=2025-10-01&to=2025-10-31</code>.</p>
        <table>
          <thead>
            <tr><th>ID</th><th>Source</th><th>Title</th><th>Starts</th><th>Venue</th><th>URL</th></tr>
          </thead>
          <tbody>${tr}</tbody>
        </table>`);
  };
}

export default createDebugHandler;
