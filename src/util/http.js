export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch JSON مع مهلة وإعادة محاولة محدودة.
 */
export async function getJson(url, { timeoutMs = 15_000, retries = 2, headers, method = 'GET', body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        // 429 / 5xx → نعيد المحاولة بعد انتظار
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${res.status} ${url}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}
