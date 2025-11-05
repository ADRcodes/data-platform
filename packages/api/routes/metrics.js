export function createMetricsHandler(db) {
  return (_req, res) => {
    const [totals] = db
      .prepare(
        `
        SELECT COUNT(*) AS total,
              SUM(CASE WHEN starts_at   IS NULL THEN 1 ELSE 0 END) AS missing_start,
              SUM(CASE WHEN image_url   IS NULL THEN 1 ELSE 0 END) AS missing_image,
              SUM(CASE WHEN description IS NULL THEN 1 ELSE 0 END) AS missing_desc
        FROM events
      `
      )
      .all();

    const recent = db
      .prepare(
        `
        SELECT source, MAX(updated_at) AS last_update, COUNT(*) AS rows
        FROM events
        GROUP BY source
        ORDER BY last_update DESC
      `
      )
      .all();

    res.json({ totals, recent });
  };
}

export default createMetricsHandler;
