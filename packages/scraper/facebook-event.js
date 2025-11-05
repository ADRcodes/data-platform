import { chromium } from "playwright";
import logger from "./logger.js";
import { parseOpenGraphFromHtml, parseDateFromText } from "./og.js";

const DEFAULT_TIMEOUT = 45000;
const VIEWPORT = { width: 1280, height: 720 };
const EVENT_SELECTORS = [
  "[data-pagelet='Event']",
  "[data-testid='event_permalink_document']",
  "[data-testid='event-permalink-container']",
  "article[data-pagelet]",
];

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
      const bySelector = (selector) =>
        Array.from(document.querySelectorAll(selector))
          .map((node) => node?.textContent?.trim?.())
          .filter(Boolean);

      const first = (arr) => (Array.isArray(arr) ? arr.find(Boolean) || null : null);

      const titleSelectors = [
        "[data-testid='event-permalink-event-name']",
        "h1",
      ];

      const timeSelectors = [
        "[data-testid='event-permalink-event-date']",
        "[data-testid='event-permalink-event-time']",
        "[data-pagelet='EventAboutSection'] time",
      ];

      const venueSelectors = [
        "[data-testid='event-permalink-event-location']",
        "[data-pagelet='EventAboutSection'] a[href*='/places/']",
        "[data-pagelet='EventAboutSection'] [role='button']",
      ];

      const descriptionSelectors = [
        "[data-testid='event-permalink-details']",
        "[data-pagelet='EventAboutSection']",
      ];

      const imageSelectors = [
        "img[data-imgperflogname='profileCoverPhoto']",
        "img[referrerpolicy][src*='scontent']",
      ];

      const ticketsSelectors = [
        "a[href*='ticket']",
        "a[href*='tickets']",
        "a[role='button']",
      ];

      const pickHref = (selector) =>
        Array.from(document.querySelectorAll(selector))
          .map((node) => node?.getAttribute?.("href")?.trim?.())
          .find((href) => typeof href === "string" && /ticket/i.test(href)) || null;

      const pickImage = (selector) =>
        Array.from(document.querySelectorAll(selector))
          .map((node) => node?.getAttribute?.("src")?.trim?.())
          .find(Boolean) || null;

      const cleanupTicketUrl = (href) => {
        if (!href) return null;
        try {
          const parsed = new URL(href, location.href);
          if (
            parsed.hostname.endsWith("facebook.com") &&
            parsed.pathname.startsWith("/l.php")
          ) {
            const target = parsed.searchParams.get("u");
            if (target) return decodeURIComponent(target);
          }
          return parsed.href;
        } catch {
          return href;
        }
      };

      const descriptionText = first(descriptionSelectors.flatMap(bySelector));

      return {
        title: first(titleSelectors.flatMap(bySelector)),
        description: descriptionText,
        start_time_text: first(timeSelectors.flatMap(bySelector)),
        venue: first(venueSelectors.flatMap(bySelector)),
        image_url: pickImage(imageSelectors.join(",")),
        tickets_url: cleanupTicketUrl(pickHref(ticketsSelectors.join(","))),
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

export async function scrapeFacebookEvent(url, options = {}) {
  const log = logger;
  const headless = options.headless ?? true;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent:
        options.userAgent ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      locale: "en-US",
    });

    const page = await context.newPage();
    await page.goto(url, { timeout, waitUntil: "domcontentloaded" });

    for (const selector of EVENT_SELECTORS) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
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

    const html = await page.content();

    if (isProbablyLoginWall(html)) {
      throw new Error("Facebook returned a login wall; unable to read event details");
    }

    const prefill = parseOpenGraphFromHtml(html, url);
    const fallbacks = await collectFallbacks(page);
    const merged = normaliseResult(prefill, fallbacks);

    if (!merged.start_time && fallbacks.start_time_text) {
      const parsed = parseDateFromText(fallbacks.start_time_text);
      if (parsed) {
        merged.start_time = parsed;
      }
    }

    if (!merged.title) {
      throw new Error("Failed to read event title from Facebook page");
    }

    return merged;
  } catch (error) {
    log.error("Facebook scrape failed", error);
    throw error;
  } finally {
    await browser.close();
  }
}

export default scrapeFacebookEvent;
