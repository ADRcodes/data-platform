import { Router } from "express";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function cleanLike(value) {
  return value.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function createEventsRouter(db) {
  const router = Router();

  router.get("/", (req, res) => {
    let { from, to, source, q, limit = "100", offset = "0" } = req.query;

    if (from && !isIsoDate(from)) from = undefined;
    if (to && !isIsoDate(to)) to = undefined;
    if (source && typeof source !== "string") source = undefined;

    const where = [];
    const params = {};

    if (from) {
      where.push("datetime(starts_at) >= datetime(@from)");
      params.from = `${from} 00:00:00`;
    }
    if (to) {
      where.push("datetime(starts_at) <= datetime(@to)");
      params.to = `${to} 23:59:59`;
    }
    if (source) {
      where.push("source = @source");
      params.source = source;
    }
    if (q && typeof q === "string") {
      const safe = `%${cleanLike(q)}%`;
      where.push("(title LIKE @q ESCAPE '\\\\' OR venue LIKE @q ESCAPE '\\\\')");
      params.q = safe;
    }

    limit = clamp(parseInt(limit, 10) || 100, 1, 200);
    offset = Math.max(parseInt(offset, 10) || 0, 0);

    const sql = `
      SELECT id, source, source_id, title, starts_at, ends_at, venue, city, url, image_url, description, price, tags
      FROM events
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY datetime(starts_at) ASC
      LIMIT @limit OFFSET @offset
    `;
    const rows = db.prepare(sql).all({ ...params, limit, offset });

    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ count: rows.length, rows });
  });

  router.get("/sources", (_req, res) => {
    const rows = db
      .prepare(
        `
        SELECT source,
              COUNT(*)                          AS total,
              SUM(CASE WHEN starts_at   IS NULL THEN 1 ELSE 0 END) AS missing_start,
              SUM(CASE WHEN image_url   IS NULL THEN 1 ELSE 0 END) AS missing_image,
              SUM(CASE WHEN description IS NULL THEN 1 ELSE 0 END) AS missing_desc
        FROM events
        GROUP BY source
        ORDER BY source ASC
      `
      )
      .all();
    res.json({ count: rows.length, rows });
  });

  router.get("/:id", (req, res) => {
    const row = db
      .prepare(
        `
        SELECT id, source, source_id, title, starts_at, ends_at, venue, city, url, image_url, description, price, tags
        FROM events WHERE id = @id
      `
      )
      .get({ id: req.params.id });
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(row);
  });

  return router;
}

export default createEventsRouter;
