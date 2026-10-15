import { ProviderError, type ProviderId } from "./domain.ts";

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/**
 * One JSON call to a provider. Network failures, timeouts, non-2xx answers and bodies that are not
 * JSON all become a ProviderError, so the gateway can decide on the fallback in one place.
 * The URL is never included in the message: some carry ids, none carry secrets, but it is noise.
 */
export async function callJson(provider: ProviderId, fetchImpl: typeof fetch, url: string, o: HttpOptions): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: o.method ?? "GET",
      headers: o.headers ?? {},
      ...(o.body !== undefined ? { body: o.body } : {}),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") throw new ProviderError(provider, "timeout", `no answer in ${o.timeoutMs} ms`);
    throw new ProviderError(provider, "network", String((e as { cause?: { code?: string } }).cause?.code ?? (e instanceof Error ? e.message : e)).slice(0, 160));
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // A bare string (Baneco's encrypt endpoint) or an HTML error page.
      body = text;
    }
  }
  return { status: res.status, body };
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** "1.5" or 1.5 → 150 cents; null when it is not an amount with at most 2 decimals. */
export function toCents(v: unknown): number | null {
  const text = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim() : "";
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?\d*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
