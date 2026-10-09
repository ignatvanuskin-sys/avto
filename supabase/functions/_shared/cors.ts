/**
 * CORS and JSON response helpers shared by every Edge Function.
 *
 * The allowed origins come from the `ALLOWED_ORIGINS` environment variable
 * (comma-separated). We only ever echo the caller's own origin, and only when
 * it is on the allow-list, so a response can never carry `Access-Control-
 * Allow-Origin: *` while credentials might be attached.
 */

/** Read and normalise the allow-list (lower-case, trimmed, empties dropped). */
function allowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') ?? '';
  return raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

/** Standard CORS headers for a request coming from `origin`. */
export function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, apikey, content-type, x-client-info, x-cron-secret',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  if (!origin) {
    return headers;
  }

  const normalized = origin.toLowerCase();
  const list = allowedOrigins();
  const explicit = list.includes(normalized);
  const wildcard = list.includes('*');

  if (explicit || wildcard) {
    // Echo the concrete origin; never emit "*" when credentials could be used.
    headers['Access-Control-Allow-Origin'] = origin;
    if (explicit) {
      // Cookies/credentials are only safe against an explicitly listed origin.
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
  }

  return headers;
}

/** Build a JSON response with a status code and any extra (e.g. CORS) headers. */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

/** Answer a CORS preflight request. */
export function handleOptions(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

/** Convenience accessor so call sites do not repeat the header lookup. */
export function requestOrigin(req: Request): string | null {
  return req.headers.get('origin');
}
