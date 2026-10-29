/**
 * @module tools/api-browser-fallback
 * API-to-Browser Fallback Agent (#13).
 * Executes a primary REST API call with strict timeout enforcement and seamlessly
 * falls back to a headless browser GUI workflow on HTTP 404/408/429/5xx or network/timeout errors,
 * while failing closed on non-fallback client errors (e.g., 400/401/403).
 */

/** HTTP status codes eligible for automatic REST-to-headless-browser fallback. */
export const FALLBACK_HTTP_STATUSES = Object.freeze([404, 408, 429, 500, 501, 502, 503, 504]);

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  'fd00:ec2::254',
  'fd00:ec2:0:0:0:0:0:254',
  '0.0.0.0',
  '::',
  '0:0:0:0:0:0:0:0'
]);

/**
 * Unwrap IPv4-mapped IPv6 hostnames (`::ffff:a.b.c.d` or WHATWG-normalized `::ffff:xxxx:yyyy`)
 * into dotted-quad IPv4 form so IPv4 metadata/loopback guards cannot be bypassed via IPv6 notation.
 *
 * @param {string} host - Normalized lowercase hostname with brackets stripped
 * @returns {string} Unwrapped IPv4 string or original `host`
 */
function unwrapIpv4MappedIpv6(host) {
  const dotted = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (dotted) {
    return dotted[1];
  }
  const hexGroups = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hexGroups) {
    const hi = Number.parseInt(hexGroups[1], 16);
    const lo = Number.parseInt(hexGroups[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return host;
}

/**
 * Validate that a target URL uses strictly `http:` or `https:` and does not target
 * cloud metadata, link-local, or non-HTTP schemes (`file:`, `javascript:`, `data:`).
 *
 * @param {string} rawUrl - Candidate URL string
 * @param {object} [options={}] - Validation options
 * @param {boolean} [options.allowLoopback=true] - Whether localhost/loopback addresses are permitted
 * @returns {{ safe: boolean, reason: string|null }}
 */
export function isSafeHttpUrl(rawUrl, { allowLoopback = true } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return { safe: false, reason: 'EMPTY_URL' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_err) {
    return { safe: false, reason: 'INVALID_URL_SYNTAX' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `UNSAFE_PROTOCOL_${parsed.protocol.replace(':', '').toUpperCase()}` };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const effectiveHost = unwrapIpv4MappedIpv6(host);

  if (
    BLOCKED_METADATA_HOSTS.has(host) ||
    BLOCKED_METADATA_HOSTS.has(effectiveHost) ||
    effectiveHost.startsWith('169.254.') ||
    effectiveHost.startsWith('0.') ||
    host.startsWith('fe80:') ||
    host.startsWith('fd00:ec2:') ||
    host.endsWith('.internal')
  ) {
    return { safe: false, reason: 'CLOUD_METADATA_OR_LINK_LOCAL_BLOCKED' };
  }

  if (
    !allowLoopback &&
    (host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '0:0:0:0:0:0:0:1' ||
      effectiveHost === '127.0.0.1' ||
      effectiveHost.startsWith('127.'))
  ) {
    return { safe: false, reason: 'LOOPBACK_HOST_BLOCKED' };
  }

  return { safe: true, reason: null };
}

/**
 * Parse a Fetch Response (or unit-test mock response) into JSON or text safely.
 *
 * @param {Response|object} response - HTTP response object
 * @returns {Promise<unknown>} Parsed body payload
 */
async function parseResponseBody(response) {
  if (!response) return null;

  const contentType =
    typeof response.headers?.get === 'function'
      ? response.headers.get('content-type') || ''
      : response.headers?.['content-type'] || '';

  if (typeof response.text === 'function') {
    const rawText = await response.text();
    if (!rawText) return null;
    const trimmed = rawText.trim();
    if (contentType.includes('application/json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch (_parseErr) {
        return rawText;
      }
    }
    return rawText;
  }

  if (typeof response.json === 'function') {
    return await response.json();
  }

  return response.body ?? null;
}

/**
 * Classify a thrown `fetch` error into a deterministic fallback reason if network/timeout related.
 *
 * @param {Error|unknown} err - Thrown error from `fetchImpl`
 * @param {boolean} timedOut - Whether the internal timeout fired
 * @returns {{ eligible: boolean, reason: string }}
 */
function classifyFetchFailure(err, timedOut) {
  if (timedOut || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return { eligible: true, reason: 'API_TIMEOUT' };
  }

  const code = err?.code || err?.cause?.code || '';
  if (code === 'ECONNREFUSED') {
    return { eligible: true, reason: 'ECONNREFUSED' };
  }
  if (['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return { eligible: true, reason: code };
  }
  if (err instanceof TypeError || err?.name === 'TypeError') {
    return { eligible: true, reason: 'FETCH_NETWORK_ERROR' };
  }

  return { eligible: false, reason: err?.message || 'UNEXPECTED_API_ERROR' };
}

/**
 * Extract inner text from HTML for simple `#id`, `.class`, or tag selectors when `extractSelector` is set.
 *
 * @param {string} html - Rendered HTML string
 * @param {string} selector - CSS selector (`#id`, `.class`, or tag name)
 * @returns {string|null} Extracted inner text if matched
 */
function extractFromHtml(html, selector) {
  if (typeof html !== 'string' || typeof selector !== 'string' || !selector.trim()) {
    return null;
  }
  const sel = selector.trim();
  let pattern = null;

  if (sel.startsWith('#')) {
    const id = sel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`<([a-zA-Z0-9-]+)[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  } else if (sel.startsWith('.')) {
    const cls = sel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`<([a-zA-Z0-9-]+)[^>]*\\bclass=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  } else if (/^[a-zA-Z0-9-]+$/.test(sel)) {
    pattern = new RegExp(`<${sel}[^>]*>([\\s\\S]*?)<\\/${sel}>`, 'i');
  }

  if (!pattern) return null;
  const match = html.match(pattern);
  if (!match) return null;
  const rawInner = sel.startsWith('#') || sel.startsWith('.') ? match[2] : match[1];
  return rawInner.replace(/<[^>]+>/g, '').trim();
}

/**
 * Routing agent that attempts a REST API request first and falls back to headless browser GUI automation
 * when the REST endpoint 404s, 429s, 5xxs, or times out.
 */
export class ApiToBrowserFallbackAgent {
  /**
   * @param {object} [options={}] - Agent configuration
   * @param {Function} [options.fetchImpl=globalThis.fetch] - Fetch implementation
   * @param {Function|object|null} [options.browserDriver=null] - Custom headless browser driver
   * @param {number} [options.apiTimeoutMs=5000] - Primary REST API timeout in milliseconds
   * @param {readonly number[]} [options.fallbackStatuses=FALLBACK_HTTP_STATUSES] - HTTP statuses triggering fallback
   * @param {boolean} [options.fallbackOnAuthError=false] - Whether 401/403 should also trigger GUI fallback
   * @param {boolean} [options.allowLoopback=true] - Whether loopback hosts (`127.0.0.1`, `localhost`) are permitted
   */
  constructor({
    fetchImpl = globalThis.fetch,
    browserDriver = null,
    apiTimeoutMs = 5000,
    fallbackStatuses = FALLBACK_HTTP_STATUSES,
    fallbackOnAuthError = false,
    allowLoopback = true
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('fetchImpl must be a function.');
    }
    if (!Number.isFinite(apiTimeoutMs) || apiTimeoutMs <= 0) {
      throw new RangeError('apiTimeoutMs must be a positive finite number.');
    }

    this.fetchImpl = fetchImpl;
    this.browserDriver = browserDriver;
    this.apiTimeoutMs = apiTimeoutMs;
    this.fallbackStatuses = Array.isArray(fallbackStatuses)
      ? fallbackStatuses
      : FALLBACK_HTTP_STATUSES;
    this.fallbackOnAuthError = Boolean(fallbackOnAuthError);
    this.allowLoopback = allowLoopback !== false;
  }

  /**
   * Invoke either the injected `browserDriver` or `@krusch/toolkit/browser` `runInteractiveSession`.
   *
   * @param {object} guiWorkflow - Browser GUI workflow definition (`{ url, steps, extractSelector }`)
   * @param {object} meta - Fallback context metadata
   * @returns {Promise<unknown>} Browser workflow result
   */
  async _executeGuiWorkflow(guiWorkflow, meta) {
    let rawResult;

    if (typeof this.browserDriver === 'function') {
      rawResult = await this.browserDriver(guiWorkflow, meta);
    } else if (this.browserDriver && typeof this.browserDriver.execute === 'function') {
      rawResult = await this.browserDriver.execute(guiWorkflow, meta);
    } else if (this.browserDriver && typeof this.browserDriver.run === 'function') {
      rawResult = await this.browserDriver.run(guiWorkflow, meta);
    } else if (this.browserDriver && typeof this.browserDriver.runInteractiveSession === 'function') {
      rawResult = await this.browserDriver.runInteractiveSession(
        guiWorkflow.url,
        guiWorkflow.steps || [],
        guiWorkflow.options || {}
      );
    } else if (guiWorkflow?.url) {
      let browserModule;
      try {
        browserModule = await import('@krusch/toolkit/browser');
      } catch (_pkgErr) {
        browserModule = await import(new URL('../../../../lib/browser.js', import.meta.url).href);
      }
      rawResult = await browserModule.runInteractiveSession(
        guiWorkflow.url,
        guiWorkflow.steps || [],
        guiWorkflow.options || {}
      );
    } else {
      throw new Error('No browserDriver configured and guiWorkflow.url is missing.');
    }

    if (
      guiWorkflow?.extractSelector &&
      rawResult &&
      typeof rawResult === 'object' &&
      typeof rawResult.html === 'string' &&
      rawResult.extracted === undefined
    ) {
      return {
        ...rawResult,
        extractSelector: guiWorkflow.extractSelector,
        extracted: extractFromHtml(rawResult.html, guiWorkflow.extractSelector)
      };
    }

    return rawResult;
  }

  /**
   * Execute `apiRequest` first; seamlessly fall back to `guiWorkflow` on eligible failures.
   *
   * @param {object} [params={}] - Execution request
   * @param {string} [params.actionName='workflow'] - Logical workflow name
   * @param {object} params.apiRequest - Primary REST API request (`{ url, method, headers, body }`)
   * @param {object} [params.guiWorkflow] - Fallback browser GUI workflow (`{ url, steps, extractSelector }`)
   * @param {boolean} [params.fallbackOnAuthError] - Optional per-call override for 401/403 handling
   * @returns {Promise<{ ok: boolean, tool: string, summary: string, data: object }>}
   */
  async execute({
    actionName = 'workflow',
    apiRequest,
    guiWorkflow = null,
    fallbackOnAuthError = this.fallbackOnAuthError
  } = {}) {
    if (!apiRequest || typeof apiRequest.url !== 'string' || apiRequest.url.trim().length === 0) {
      return {
        ok: false,
        tool: 'krusch_api_browser_fallback',
        summary: `Cannot execute ${actionName}: apiRequest.url is required.`,
        data: {
          actionName,
          channel: 'none',
          fallbackTriggered: false,
          fallbackReason: 'INVALID_API_REQUEST',
          apiStatus: null,
          result: null,
          attempts: []
        }
      };
    }

    const apiUrlCheck = isSafeHttpUrl(apiRequest.url, { allowLoopback: this.allowLoopback });
    if (!apiUrlCheck.safe) {
      return {
        ok: false,
        tool: 'krusch_api_browser_fallback',
        summary: `Blocked unsafe primary API URL for ${actionName}: ${apiUrlCheck.reason}`,
        data: {
          actionName,
          channel: 'none',
          fallbackTriggered: false,
          fallbackReason: 'UNSAFE_URL_BLOCKED',
          unsafeUrlReason: apiUrlCheck.reason,
          apiStatus: null,
          result: null,
          attempts: []
        }
      };
    }

    if (guiWorkflow && typeof guiWorkflow.url === 'string' && guiWorkflow.url.trim().length > 0) {
      const guiUrlCheck = isSafeHttpUrl(guiWorkflow.url, { allowLoopback: this.allowLoopback });
      if (!guiUrlCheck.safe) {
        return {
          ok: false,
          tool: 'krusch_api_browser_fallback',
          summary: `Blocked unsafe fallback GUI URL for ${actionName}: ${guiUrlCheck.reason}`,
          data: {
            actionName,
            channel: 'none',
            fallbackTriggered: false,
            fallbackReason: 'UNSAFE_URL_BLOCKED',
            unsafeUrlReason: guiUrlCheck.reason,
            apiStatus: null,
            result: null,
            attempts: []
          }
        };
      }
    }

    const attempts = [];
    const method = (apiRequest.method || 'GET').toUpperCase();
    const headers = { ...(apiRequest.headers || {}) };
    let serializedBody = apiRequest.body;
    if (
      serializedBody !== undefined &&
      serializedBody !== null &&
      typeof serializedBody === 'object' &&
      !(serializedBody instanceof Uint8Array)
    ) {
      serializedBody = JSON.stringify(serializedBody);
      const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
      if (!hasContentType) {
        headers['content-type'] = 'application/json';
      }
    }

    const timeoutMs = apiRequest.timeoutMs ?? this.apiTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const timeoutErr = new DOMException(
          `REST API timed out after ${timeoutMs}ms`,
          'TimeoutError'
        );
        controller.abort(timeoutErr);
        reject(timeoutErr);
      }, timeoutMs);
    });

    let fallbackReason = null;
    let apiStatus = null;
    const apiStartMs = Date.now();

    try {
      const fetchPromise = this.fetchImpl(apiRequest.url, {
        method,
        headers,
        body: serializedBody,
        signal: controller.signal
      });
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      const durationMs = Date.now() - apiStartMs;
      apiStatus = response.status;
      const parsedBody = await parseResponseBody(response);

      attempts.push({
        channel: 'rest_api',
        url: apiRequest.url,
        method,
        status: response.status,
        ok: Boolean(response.ok),
        durationMs
      });

      if (response.ok) {
        return {
          ok: true,
          tool: 'krusch_api_browser_fallback',
          summary: `Completed ${actionName} via REST API (HTTP ${response.status}).`,
          data: {
            actionName,
            channel: 'rest_api',
            fallbackTriggered: false,
            fallbackReason: null,
            apiStatus: response.status,
            result: parsedBody,
            attempts
          }
        };
      }

      const isAuthFallback =
        Boolean(fallbackOnAuthError) && (response.status === 401 || response.status === 403);
      const shouldFallback = this.fallbackStatuses.includes(response.status) || isAuthFallback;

      if (!shouldFallback) {
        return {
          ok: false,
          tool: 'krusch_api_browser_fallback',
          summary: `REST API returned non-fallback HTTP ${response.status} for ${actionName}; failing closed.`,
          data: {
            actionName,
            channel: 'rest_api',
            fallbackTriggered: false,
            fallbackReason: null,
            apiStatus: response.status,
            result: parsedBody,
            attempts
          }
        };
      }

      fallbackReason = `HTTP_${response.status}`;
    } catch (err) {
      const durationMs = Date.now() - apiStartMs;
      const classification = classifyFetchFailure(err, timedOut);
      attempts.push({
        channel: 'rest_api',
        url: apiRequest.url,
        method,
        status: null,
        ok: false,
        durationMs,
        error: err?.message || String(err)
      });

      if (!classification.eligible) {
        return {
          ok: false,
          tool: 'krusch_api_browser_fallback',
          summary: `REST API failed with non-recoverable error for ${actionName}: ${classification.reason}`,
          data: {
            actionName,
            channel: 'rest_api',
            fallbackTriggered: false,
            fallbackReason: classification.reason,
            apiStatus: null,
            result: null,
            attempts
          }
        };
      }

      fallbackReason = classification.reason;
    } finally {
      clearTimeout(timer);
    }

    if (!guiWorkflow || typeof guiWorkflow !== 'object') {
      return {
        ok: false,
        tool: 'krusch_api_browser_fallback',
        summary: `REST API failed (${fallbackReason}) and no guiWorkflow fallback was provided for ${actionName}.`,
        data: {
          actionName,
          channel: 'rest_api',
          fallbackTriggered: false,
          fallbackReason,
          apiStatus,
          result: null,
          attempts
        }
      };
    }

    const guiStartMs = Date.now();
    try {
      const guiResult = await this._executeGuiWorkflow(guiWorkflow, {
        actionName,
        fallbackReason,
        apiStatus
      });
      attempts.push({
        channel: 'headless_browser',
        url: guiWorkflow.url || null,
        ok: true,
        durationMs: Date.now() - guiStartMs
      });

      return {
        ok: true,
        tool: 'krusch_api_browser_fallback',
        summary: `REST API failed (${fallbackReason}); completed ${actionName} via headless browser fallback.`,
        data: {
          actionName,
          channel: 'headless_browser',
          fallbackTriggered: true,
          fallbackReason,
          apiStatus,
          result: guiResult,
          attempts
        }
      };
    } catch (browserErr) {
      const errorMsg = browserErr?.message || String(browserErr);
      attempts.push({
        channel: 'headless_browser',
        url: guiWorkflow.url || null,
        ok: false,
        durationMs: Date.now() - guiStartMs,
        error: errorMsg
      });

      return {
        ok: false,
        tool: 'krusch_api_browser_fallback',
        summary: `REST API (${fallbackReason}) and headless browser fallback both failed for ${actionName}: ${errorMsg}`,
        data: {
          actionName,
          channel: 'headless_browser',
          fallbackTriggered: true,
          fallbackReason,
          apiStatus,
          result: null,
          error: errorMsg,
          attempts
        }
      };
    }
  }
}
