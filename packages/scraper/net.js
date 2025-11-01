import axios from "axios";
import axiosRetry from "axios-retry";

export const http = axios.create({
  headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Safari/537.36" },
  timeout: 20000,
});
axiosRetry(http, {
  retries: 4,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: err =>
    axiosRetry.isNetworkError(err) ||
    axiosRetry.isRetryableError(err) ||
    [429, 500, 502, 503, 504].includes(err?.response?.status),
});
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function polite(ms = 400, jitter = 350) {
  await sleep(ms + Math.floor(Math.random() * jitter));
}
