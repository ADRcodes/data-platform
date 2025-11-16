import crypto from "node:crypto";

export function absoluteUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return href || null; }
}

export function extractFirstImageUrl($, root, baseUrl) {
  // Try <img> tags first
  const img = $(root).find("img").first();
  let src =
    img.attr("data-src") ||
    img.attr("data-lazy-src") ||
    (img.attr("srcset")?.split(",")[0]?.trim().split(" ")[0]) ||
    img.attr("src");

  if (!src) {
    // Try inline style background-image: url(...)
    const styled = $(root).find("[style*='background']").filter((_, el) => {
      const s = ($(el).attr("style") || "").toLowerCase();
      return s.includes("background") && s.includes("url(");
    }).first();
    const style = styled.attr("style");
    if (style) {
      const m = style.match(/url\((['"]?)(.*?)\1\)/i);
      if (m) src = m[2];
    }
  }
  return src ? absoluteUrl(baseUrl, src) : null;
}

export function firstNonMetaText(lines) {
  // Drop obvious date/time/cta/venue-ish lines to form a short description
  const bad = [
    /buy tickets|details|more info|just show up/i,
    /\d{1,2}:\d{2}\s*[ap]m/i,
    /all day/i,
    /(january|february|march|april|may|june|july|august|september|october|november|december)/i,
    /majestic|theatre hill|mainstage|stage|casa amigos|st\. john/i
  ];
  const candidate = lines.find(s => s && !bad.some(rx => rx.test(s)));
  return candidate ? candidate.replace(/\s+/g, " ").trim().slice(0, 300) : null;
}

export function contentHash(event) {
  const stable = JSON.stringify({
    title: event.title?.trim() ?? "",
    starts_at: event.starts_at ?? null,
    ends_at: event.ends_at ?? null,
    venue: event.venue?.trim() ?? null,
    city: event.city ?? null,
    url: event.url ?? null,
    image_url: event.image_url ?? null,
    description: event.description ?? null,
    price: event.price ?? null,
    tags: event.tags ?? "",
  });
  return crypto.createHash("sha1").update(stable).digest("hex");
}
