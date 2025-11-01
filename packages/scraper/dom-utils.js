import * as cheerio from "cheerio";

/** Try to parse the first JSON-LD Event block on a page. */
export function extractEventJsonLd(html) {
  const $ = cheerio.load(html);
  const blocks = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).contents().text())
    .get();
  for (const raw of blocks) {
    try {
      const json = JSON.parse(raw.trim());
      const nodes = Array.isArray(json) ? json : [json];
      for (const node of flattenLd(nodes)) {
        const type = node['@type'] || node['@context']?.['@type'];
        if (!type) continue;
        const t = Array.isArray(type) ? type : [type];
        if (t.includes("Event")) {
          return {
            title: node.name || null,
            description: node.description || null,
            starts_at: node.startDate || null,
            ends_at: node.endDate || null,
            venue: node.location?.name || null,
            image_url: Array.isArray(node.image) ? node.image[0] : node.image || null,
          };
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

function flattenLd(arr) {
  const out = [];
  const stack = [...arr];
  while (stack.length) {
    const v = stack.pop();
    if (!v) continue;
    out.push(v);
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (Array.isArray(val)) stack.push(...val);
      else if (val && typeof val === 'object') stack.push(val);
    }
  }
  return out;
}

/** Grab og:image if present. */
export function extractOgImage(html) {
  const $ = cheerio.load(html);
  return $('meta[property="og:image"]').attr('content') || null;
}

/** Cheap text normalizer for descriptions. */
export function normalizeText(s) {
  return s?.replace(/\s+/g, ' ').trim() || null;
}
