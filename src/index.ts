interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * Shared query layer for CourtListener docket data.
 *
 * Four packs — bankruptcy, federal-criminal, federal-civil, federal-appellate —
 * read the SAME table with different filters. They are separate packs because
 * routing is embedding cosine over tool descriptions, and four descriptions
 * tuned to four questions match far better than one generic "search dockets".
 * They share one table because splitting the storage would quadruple the
 * operational surface and the bill to buy nothing.
 *
 * This lives in shared rather than being copied four times, so a fix to the
 * query shape lands once. publish-pack.sh inlines it when a pack ships
 * standalone.
 *
 * Data: 36.4M dockets, consumer bankruptcy excluded. A docket records that a
 * case EXISTS — parties, court, dates, judge. It contains none of the filings;
 * those are RECAP, which is a separate and non-keyless corpus. Any tool built
 * on this must not imply otherwise.
 */


interface DocketMirror {
  url: string;
  key: string;
}

interface DocketRow {
  id: number;
  case_name: string | null;
  case_name_full: string | null;
  docket_number: string | null;
  court_id: string;
  court_class: string;
  is_criminal: boolean;
  is_business_bankruptcy: boolean;
  date_filed: string | null;
  date_terminated: string | null;
  date_last_filing: string | null;
  cause: string | null;
  nature_of_suit: string | null;
  jurisdiction_type: string | null;
  assigned_to_str: string | null;
  pacer_case_id: string | null;
  snapshot_date: string;
}

function docketMirror(args: Record<string, unknown>): DocketMirror | null {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  return url && key ? { url, key } : null;
}

function docketUnavailable(tool: string) {
  return {
    found: false,
    reason: 'mirror_unavailable',
    message: `${tool} is not reachable from this deployment.`,
    hint: 'Case law (opinions, full text) is served by the court-listener pack and is unaffected.',
  };
}

/** Present a docket without implying we hold the filings. */
function shapeDocket(d: DocketRow) {
  return {
    docket_id: d.id,
    case_name: d.case_name,
    case_name_full: d.case_name_full,
    docket_number: d.docket_number,
    court: d.court_id,
    court_class: d.court_class,
    date_filed: d.date_filed,
    date_terminated: d.date_terminated,
    // Absence is not closure: date_terminated is 78.3% filled, so a null means
    // "not recorded", never "still open". Stating that on the row keeps a
    // caller from reading an open case out of a missing field.
    status: d.date_terminated ? 'terminated' : 'no termination date recorded',
    date_last_filing: d.date_last_filing,
    cause: d.cause,
    nature_of_suit: d.nature_of_suit,
    assigned_judge: d.assigned_to_str,
    pacer_case_id: d.pacer_case_id,
    courtlistener_url: `https://www.courtlistener.com/docket/${d.id}/`,
    // Which path this row came from. Present on every row of every response so
    // that a merged list is readable without inferring anything from which
    // fields happen to be filled.
    coverage: 'mirror' as const,
  };
}

// ── The live fall-through ─────────────────────────────────────────────
//
// The bulk docket export is a quarterly-ish file, so a party search against it
// alone answers "nobody is suing them" for a suit filed last week. That is the
// silent-zero class: a clean 200 with a complete-looking result set and three
// of the seven cases missing (feedback #140, 2026-10-08 — Capricor, where the
// covered window ended 2026-06-30 and the suits were filed July–September).
//
// CourtListener's own /search/?type=r is the fix and needs no API token. Two
// things about it are load-bearing and were both verified against the live
// endpoint on 2026-10-11:
//
//  - SCOPING MUST GO THROUGH `q`, as a fielded term. `q=Capricor` is a
//    free-text search over docket AND filing text: it returned 45 rows
//    including NUFIO v. SWEEPSTEAKS, In re PayPal and Beyond Meat, which
//    mention the company nowhere in their caption. `q=party:(Capricor)`
//    returned exactly 3. Handing a caller the first set as "lawsuits against
//    Capricor" would be worse than the stale answer it replaces.
//  - `filed_after` / `filed_before` ARE real query parameters here (unlike
//    `docket_id`, which /search/ ignores silently — see the RECAP note in the
//    court-listener pack). `filed_after=2026-07-01` narrowed those 3 correctly.
//
// It is throttled to ~125 requests/day for a token-less caller. Measured
// 2026-10-11, the four packs on this rail took 22 party searches in 30 days, so
// one upstream call per party search is not near that ceiling. If it ever is,
// the throttle surfaces as `live_lookup.error` rather than as an empty result.
const CL_DOCKET_SEARCH = 'https://www.courtlistener.com/api/rest/v4/search/';

// RECAP is PACER, so it holds federal district, bankruptcy and appellate
// dockets and no state ones. Going live for a state-court class would spend a
// request to learn nothing, every time.
const LIVE_CLASSES = new Set(['federal_district', 'federal_bankruptcy', 'federal_appellate']);

// Both of these are the loader's rules, verbatim, from
// scripts/courtlistener-load-dockets.py (CRIMINAL and ENTITY). They are copied
// rather than approximated on purpose: is_criminal and is_business_bankruptcy
// are DERIVED columns, not upstream ones, so a live row classified by a
// different rule would land in a result set beside mirror rows classified by
// this one, and the pack boundary would mean two different things in one
// response. If the loader's rules change, change these with them.
const CRIMINAL_CAPTION = /^\s*(usa?|united states)\b[\s,]*v/i;
const ENTITY = new RegExp(
  String.raw`\b(inc|incorporated|llc|l\.l\.c|llp|lp|l\.p|pllc|pc|plc|` +
    String.raw`corp|corporation|ltd|limited|co|company|companies|` +
    String.raw`holdings?|partners|partnership|associates|enterprises|ventures|` +
    String.raw`industries|services|systems|solutions|technologies|properties|realty|` +
    String.raw`management|capital|fund|group|trust|bank|bancorp|` +
    String.raw`restaurants?|motors|foundation|association|church|ministries|` +
    String.raw`hospital|clinic|university|college|academy|school|` +
    String.raw`construction|contracting|transport|trucking|logistics|farms?|ranch|` +
    String.raw`petroleum|energy|mining|pharmaceuticals?|laborator(y|ies)|` +
    String.raw`communications|media|productions|studios|entertainment)\b`,
  'i',
);

interface LiveDocketRow {
  docket_id?: number | null;
  caseName?: string | null;
  case_name_full?: string | null;
  docketNumber?: string | null;
  /** CourtListener's own human name for the court, e.g. "District Court, S.D. California". */
  court?: string | null;
  court_id?: string | null;
  dateFiled?: string | null;
  dateTerminated?: string | null;
  cause?: string | null;
  suitNature?: string | null;
  assignedTo?: string | null;
  pacer_case_id?: string | null;
  /** Only ever set on a bankruptcy docket. */
  chapter?: string | number | null;
  /** Every named party, which is the one thing the bulk export does not carry. */
  party?: string[] | null;
}

/**
 * Which court class a live row belongs to, from CourtListener's own name for
 * the court.
 *
 * POSITIVE matching only: an unrecognised court returns null and the row is
 * DROPPED, never guessed into a class. The failure this avoids is a bankruptcy
 * or appellate docket appearing in a federal-civil result because the rule did
 * not recognise it and defaulted — which reads as a real district-court suit
 * and is unfalsifiable from the response.
 *
 * The court NAME is used rather than a court_id pattern because it is data
 * CourtListener sends, not a convention we inferred. Checked against the mirror
 * on 2026-10-11: the four territorial district courts (prd, vid, gud, nmid) are
 * all court_class=federal_district there, and CourtListener names each of them
 * "District Court, ...", so the two paths agree on them rather than the live
 * path quietly dropping Puerto Rico.
 */
function liveCourtClass(r: LiveDocketRow): string | null {
  const name = (r.court ?? '').trim();
  if (/bankrupt/i.test(name)) return 'federal_bankruptcy';
  if (/court of appeals|supreme court/i.test(name)) return 'federal_appellate';
  if (/^district court\b/i.test(name)) return 'federal_district';
  // chapter is set on bankruptcy dockets and nothing else, so it settles a row
  // whose court name we do not recognise.
  if (r.chapter !== null && r.chapter !== undefined && r.chapter !== '') return 'federal_bankruptcy';
  return null;
}

function liveMatchesFilters(
  r: LiveDocketRow,
  filters: { court_class?: string; is_criminal?: boolean; is_business_bankruptcy?: boolean },
): boolean {
  if (filters.court_class && liveCourtClass(r) !== filters.court_class) return false;
  const name = (r.caseName ?? r.case_name_full ?? '').trim();
  if (filters.is_criminal !== undefined && CRIMINAL_CAPTION.test(name) !== filters.is_criminal) return false;
  if (filters.is_business_bankruptcy !== undefined && ENTITY.test(name) !== filters.is_business_bankruptcy) {
    return false;
  }
  return true;
}

/** A live row in the same shape as a mirror row, so a caller reads one list. */
function shapeLiveDocket(r: LiveDocketRow) {
  return {
    docket_id: r.docket_id ?? null,
    case_name: r.caseName ?? null,
    case_name_full: r.case_name_full || null,
    docket_number: r.docketNumber ?? null,
    court: r.court_id ?? null,
    court_class: liveCourtClass(r),
    date_filed: r.dateFiled ?? null,
    date_terminated: r.dateTerminated ?? null,
    status: r.dateTerminated ? 'terminated' : 'no termination date recorded',
    // The bulk export carries date_last_filing; the search index does not
    // expose it. Null here means "not available on this path", which is why
    // every row says which path it came from.
    date_last_filing: null,
    cause: r.cause || null,
    nature_of_suit: r.suitNature || null,
    assigned_judge: r.assignedTo || null,
    pacer_case_id: r.pacer_case_id ?? null,
    courtlistener_url: r.docket_id ? `https://www.courtlistener.com/docket/${r.docket_id}/` : null,
    // Every named party, present only on this path — see party_index_note.
    ...(r.party?.length ? { parties: r.party } : {}),
    coverage: 'live' as const,
  };
}

/**
 * How far the bulk docket data runs, and — when it cannot say — WHY.
 *
 * Read from courtlistener_docket_snapshots rather than off the first result
 * row, because the first row's snapshot_date does not exist when the search
 * matched nothing — which is exactly the case where a caller needs to know
 * where coverage ends in order to read the empty result correctly.
 *
 * Three outcomes, never one null (fleet #2926). This used to return
 * `string | null` behind a `.catch(() => null)` at the call site, so a
 * mirror that could not be reached, a marker table nobody had written, and a
 * genuinely unknown horizon were the same value — and the envelope said
 * "an unrecorded date" for all three. A caller cannot act on that: an
 * unreachable lookup is retryable and a missing marker is not.
 */
type CoverageHorizon =
  | { state: 'recorded'; date: string }
  | { state: 'unrecorded'; date: null }
  | { state: 'unavailable'; date: null; error: string };

async function coverageHorizon(m: DocketMirror): Promise<CoverageHorizon> {
  try {
    const res = await fetch(
      `${m.url}/rest/v1/courtlistener_docket_snapshots?select=snapshot_date&order=snapshot_date.desc&limit=1`,
      { headers: { apikey: m.key, Authorization: `Bearer ${m.key}` } },
    );
    if (!res.ok) {
      return {
        state: 'unavailable',
        date: null,
        error: `coverage marker lookup returned HTTP ${res.status}`,
      };
    }
    const rows = (await res.json()) as { snapshot_date?: string }[];
    const date = rows[0]?.snapshot_date;
    // An EMPTY table is a different fact from an unreachable one: it means no
    // load has ever recorded where it finished. Both are "we do not know",
    // only one is worth retrying.
    return date ? { state: 'recorded', date } : { state: 'unrecorded', date: null };
  } catch (err) {
    return {
      state: 'unavailable',
      date: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The phrase that goes where a date would, so an absent horizon states its own
 * reason in the sentence a caller actually reads.
 *
 * `h === null` means the horizon was never looked up on this path (a browse
 * with no party, which answers from the bulk data alone) — that keeps the
 * original wording rather than claiming a reason this call never established.
 */
function horizonPhrase(coveredThrough: string | null, h: CoverageHorizon | null): string {
  if (coveredThrough) return coveredThrough;
  if (h?.state === 'unavailable') {
    return `a date this response could NOT establish — the coverage marker lookup failed (${h.error}), so where coverage ends is unknown rather than absent, and this result does not rule out a case inside the covered period`;
  }
  if (h?.state === 'unrecorded') {
    return 'a date no load has recorded — the coverage marker table is empty, so where coverage ends is unknown';
  }
  return 'an unrecorded date';
}

async function liveDockets(opts: {
  party: string;
  court?: string;
  filedAfter?: string | null;
  filedBefore?: string | null;
  limit: number;
}): Promise<LiveDocketRow[]> {
  // The party name becomes a fielded Lucene term, so the characters Lucene
  // treats as syntax have to go or the query is rejected (or, worse, silently
  // means something else).
  const term = opts.party.replace(/[()[\]{}"~^:\\/+!&|*?-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!term) return [];
  const params = new URLSearchParams({
    type: 'r',
    q: `party:(${term})`,
    order_by: 'dateFiled desc',
  });
  if (opts.court) params.set('court', opts.court);
  if (opts.filedAfter) params.set('filed_after', opts.filedAfter);
  if (opts.filedBefore) params.set('filed_before', opts.filedBefore);

  const res = await fetchWithTimeout(
    `${CL_DOCKET_SEARCH}?${params}`,
    { headers: { Accept: 'application/json' } },
    'CourtListener docket search',
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(
      res.status === 429
        ? `CourtListener's docket search is throttled to about 125 requests a day for callers without an API token, and that budget is currently spent (HTTP 429). This is an upstream rate limit, not an absence of cases.`
        : `CourtListener docket search failed (HTTP ${res.status}): ${body}`,
    );
  }
  const data = (await res.json()) as { results?: LiveDocketRow[] };
  return data.results ?? [];
}

/** The later of two YYYY-MM-DD dates, ignoring absent ones. */
function laterDate(a?: string | null, b?: string | null): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Query the docket mirror.
 *
 * Throws on failure rather than returning an empty array. The first version
 * swallowed every error into [], which meant a pack pointed at the WRONG
 * DATABASE reported "no dockets matched" — indistinguishable from a genuine
 * miss, and the caller would have believed it. An empty result must mean the
 * data is not there, never that we could not ask.
 */
async function query(m: DocketMirror, qs: string): Promise<DocketRow[]> {
  const res = await fetch(`${m.url}/rest/v1/courtlistener_dockets?${qs}`, {
    headers: { apikey: m.key, Authorization: `Bearer ${m.key}` },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(
      `Docket query failed (HTTP ${res.status}) against ${m.url.replace(/https?:\/\//, '').split('.')[0]}: ${body}`,
    );
  }
  return (await res.json()) as DocketRow[];
}

interface DocketSearch {
  party?: string;
  court?: string;
  /**
   * Filter for real on both paths: parameters to search_dockets_by_name on the
   * party path (since migration 080), PostgREST filters on the browse path.
   * They used to be a client-side trim of the page the RPC had already cut to
   * `limit`, which quietly returned fewer rows than asked for and gave the
   * planner nothing to work with. The tool schemas describe them as filters;
   * keep them honest if this ever changes.
   */
  filedAfter?: string;
  filedBefore?: string;
  limit?: number;
  /**
   * Annotate returned dockets with the state court they were removed from.
   * Federal district civil only — see the removal section at the foot of this
   * file for what it costs and which route it takes. Off unless asked for, so
   * a pack that has no removal question to answer spends no upstream request.
   */
  checkRemoval?: boolean;
}

/**
 * Search dockets within one court class.
 *
 * Party match is a name substring rather than full-text: docket case names are
 * short and adversarial ("Acme Corp v. Smith"), so a caller searching one party
 * needs to match a fragment, which tsquery does badly and ilike does well.
 */
async function searchDockets(
  m: DocketMirror,
  filters: { court_class?: string; is_criminal?: boolean; is_business_bankruptcy?: boolean },
  s: DocketSearch,
) {
  const limit = Math.min(50, Math.max(1, s.limit ?? 10));

  const fetchRows = async (filedAfter?: string, filedBefore?: string): Promise<DocketRow[]> => {
  if (s.party) {
    // Name search goes through the RPC, never a PostgREST ilike filter. An
    // ilike scan over 36M rows exceeds the 8s statement timeout — which the
    // packs reported as "no filings found" until this layer was made to throw.
    // The RPC matches the expression the FTS index is built on; PostgREST's own
    // fts operator generates a different one that the planner ignores.
    return rpc(m, {
      q: s.party.replace(/[*,()]/g, ' ').trim(),
      p_court_class: filters.court_class ?? null,
      p_is_criminal: filters.is_criminal ?? null,
      p_business_bk: filters.is_business_bankruptcy ?? null,
      p_court: s.court ?? null,
      // The dates go to the RPC now, and did not before. Trimming them here, on
      // rows the database had ALREADY cut to `limit`, meant a date-bounded
      // search silently returned a subset of what was asked for: ask for 10
      // dockets filed after 2020 and you got however many of the newest 10
      // happened to qualify, with nothing in the response saying the rest had
      // been dropped. It also denied the planner its one selective predicate.
      // See migration 080.
      p_filed_after: filedAfter ?? null,
      p_filed_before: filedBefore ?? null,
      lim: limit,
    });
  } else {
    const parts: string[] = ['select=*'];
    if (filters.court_class) parts.push(`court_class=eq.${filters.court_class}`);
    if (filters.is_criminal !== undefined) parts.push(`is_criminal=is.${filters.is_criminal}`);
    if (filters.is_business_bankruptcy !== undefined) {
      parts.push(`is_business_bankruptcy=is.${filters.is_business_bankruptcy}`);
    }
    if (s.court) parts.push(`court_id=eq.${encodeURIComponent(s.court)}`);
    if (filedAfter) parts.push(`date_filed=gte.${filedAfter}`);
    if (filedBefore) parts.push(`date_filed=lte.${filedBefore}`);
    parts.push('order=date_filed.desc.nullslast');
    parts.push(`limit=${limit}`);
    return query(m, parts.join('&'));
  }
  };

  let rows: DocketRow[] = await fetchRows(s.filedAfter, s.filedBefore);

  // ── Live fall-through ───────────────────────────────────────────────
  //
  // Runs for a PARTY search only. A browse with no party would have to send a
  // match-everything query upstream, which /search/ answers with an arbitrary
  // slice of 61M dockets — so federal_civil_recent and its siblings stay on the
  // bulk data alone and keep saying so through snapshot_date.
  const liveEligible = Boolean(s.party) && LIVE_CLASSES.has(filters.court_class ?? '');
  let horizon: CoverageHorizon | null = null;
  let liveRows: ReturnType<typeof shapeLiveDocket>[] = [];
  let live: {
    attempted: boolean;
    filed_after: string | null;
    returned?: number;
    dropped_other_court_class?: number;
    error?: string;
  } | undefined;

  // Looked up when the live path needs a start date, AND whenever the bulk data
  // matched nothing — the empty result is the case this marker exists for, and
  // on a browse it used to be the one case that never asked (fleet #2926).
  if (liveEligible || rows.length === 0) {
    horizon = await coverageHorizon(m);
  }

  if (liveEligible) {
    const coveredThrough = horizon?.date ?? rows[0]?.snapshot_date ?? null;

    // Where the live search starts, and why the two cases differ:
    //
    //  - The bulk data matched NOTHING -> search the caller's whole window.
    //    The miss may be INSIDE the covered period, because the two indexes do
    //    not hold the same thing: the bulk export carries case_name only, so a
    //    derivative suit captioned against officers (Rosen v. Marban, casd
    //    3:25-cv-03270) is unreachable by the company's name there, while
    //    RECAP indexes every named party and finds it. Starting at the horizon
    //    would hide precisely that class of miss.
    //  - The bulk data matched something -> ask only for the gap past the
    //    horizon. Re-asking for the covered period would spend the throttle to
    //    retrieve rows we already have, and dedupe would discard them.
    const from = rows.length === 0 ? (s.filedAfter ?? null) : laterDate(s.filedAfter, coveredThrough);

    // A window that closes before coverage ends has no gap to fill — but only
    // skip when the bulk data actually answered, since an empty result is the
    // party-index case above and is not evidence of anything.
    const windowFullyCovered = Boolean(s.filedBefore && coveredThrough && s.filedBefore <= coveredThrough);

    if (rows.length > 0 && windowFullyCovered) {
      live = { attempted: false, filed_after: null };
    } else {
      live = { attempted: true, filed_after: from };
      try {
        const raw = await liveDockets({
          party: String(s.party),
          court: s.court,
          filedAfter: from,
          filedBefore: s.filedBefore ?? null,
          limit,
        });
        const kept = raw.filter((r) => liveMatchesFilters(r, filters));
        liveRows = kept.map(shapeLiveDocket);
        live.returned = liveRows.length;
        live.dropped_other_court_class = raw.length - kept.length;
      } catch (err) {
        // A live failure must not fail a call the bulk data already answered —
        // but it must never be silent either, because "no newer case" and
        // "could not ask about newer cases" are the same empty list otherwise.
        live.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // A date window beyond what this dataset covers returns 0 rows as a clean
  // success — "securities class actions filed after 2026-07-24" answered
  // "none exist" when the truth was "the coverage ends earlier" (fleet #508's
  // verbatim question died here after the routing fix). On a dated empty,
  // retry once WITHOUT the dates: if data exists, return the newest available
  // and say the window outran what is covered — the caller learns the
  // coverage horizon instead of a false negative.
  //
  // This now runs only when the LIVE path came back empty too, because the
  // live path is the thing that actually extends coverage: widening the window
  // first would answer a 2026-09 question with 2026-05 rows while the real
  // 2026-09 cases were one request away.
  let dateWindowNote: string | undefined;
  if (rows.length === 0 && liveRows.length === 0 && (s.filedAfter || s.filedBefore)) {
    const undated = await fetchRows(undefined, undefined);
    if (undated.length > 0) {
      rows = undated;
      // WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts:
      // no "the mirror's" / "the mirror holds" — that is a claim about who
      // stores what, not about what the data says. check:hosting-claims did
      // not catch this before shared/ was wired into its string pass (task
      // #2009); "pipeworx mirror of CourtListener bulk data" a few lines
      // below was the same defect on the `source` field of every response on
      // this rail, across all five packs that call searchDockets().
      dateWindowNote =
        `No dockets matched within the requested date window (${s.filedAfter ?? ''}..${s.filedBefore ?? ''}) — the newest matching docket on file is ${undated[0]?.date_filed ?? 'unknown'}, so the window likely outran what is covered. Returning the newest matching dockets available; treat absence WITHIN the window as UNKNOWN, not as zero filings.`;
    }
  }

  // Merge newest-first and dedupe on the CourtListener docket id, which both
  // paths carry and which is the same id space. Bulk rows win a tie: they
  // carry date_last_filing, which the search index does not expose.
  const seen = new Set<number>();
  const shaped: Record<string, unknown>[] = [];
  for (const d of [...rows.map(shapeDocket), ...liveRows] as Record<string, unknown>[]) {
    const id = d.docket_id;
    if (typeof id === 'number') {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    shaped.push(d);
  }
  const dockets = shaped
    .sort((a, b) => String(b.date_filed ?? '').localeCompare(String(a.date_filed ?? '')))
    .slice(0, limit);

  const liveShown = dockets.filter((d) => d.coverage === 'live').length;
  const coveredThrough = horizon?.date ?? rows[0]?.snapshot_date ?? null;
  const horizonText = horizonPhrase(coveredThrough, horizon);

  // Removal annotation runs LAST, on the rows that are actually being returned,
  // so the upstream budget is spent on the answer rather than on candidates the
  // limit discarded. It attaches to the row, because which case was removed is
  // a property of the case and not of the query.
  let removal: RemovalLookup | undefined;
  if (s.checkRemoval && dockets.length > 0) {
    const r = await removalLookups(
      dockets.map((d) => d.docket_id).filter((n): n is number => typeof n === 'number'),
    );
    removal = r.lookup;
    for (const d of dockets) {
      const got = typeof d.docket_id === 'number' ? r.byDocket.get(d.docket_id) : undefined;
      // Omitted, never nulled: a `removed_from: null` on a docket whose notice
      // we could not retrieve asserts the case was not removed, which is a
      // claim this path cannot make.
      if (got) d.removed_from = got;
    }
  }

  return {
    returned: dockets.length,
    dockets,
    ...(dateWindowNote ? { date_window_note: dateWindowNote } : {}),
    snapshot_date: coveredThrough,
    // snapshot_date alone cannot carry this: `null` is three different facts
    // (no marker written / marker unreachable / never asked), and a caller
    // that cannot tell them apart cannot tell a retryable failure from a
    // settled absence. Emitted only when this call actually looked.
    ...(horizon
      ? {
          coverage_horizon: {
            snapshot_date: coveredThrough,
            state: horizon.state,
            source:
              horizon.state === 'recorded'
                ? ('snapshot_marker' as const)
                : coveredThrough
                  ? ('first_result_row' as const)
                  : ('none' as const),
            ...(horizon.state === 'unavailable' ? { error: horizon.error } : {}),
            note:
              horizon.state === 'recorded'
                ? 'Read from courtlistener_docket_snapshots, which a bulk load writes as its last step — so it describes a load that finished.'
                : horizon.state === 'unavailable'
                  ? 'The coverage marker could NOT be read, so where the bulk data ends is UNKNOWN on this response, not absent. Retryable; treat an empty result as unknown rather than as zero filings.'
                  : 'No bulk load has recorded a coverage marker, so where the bulk data ends is unknown. Not retryable — it needs courtlistener-load-dockets.py --mark-snapshot to run.',
          },
        }
      : {}),
    ...(live ? { live_lookup: live } : {}),
    ...(removal ? { removal_lookup: removal } : {}),
    // Per-row `coverage` says which path each docket came from; this says what
    // the list as a whole is, so a caller who reads only the envelope is not
    // told the whole thing is as old as the bulk file.
    coverage:
      liveShown > 0
        ? `${dockets.length - liveShown} docket(s) from CourtListener bulk data covering filings through ${horizonText}, plus ${liveShown} from a live CourtListener search covering filings after that`
        : `CourtListener bulk data, covering filings through ${horizonText}`,
    source:
      liveShown > 0
        ? 'CourtListener bulk docket data + live CourtListener docket search'
        : 'CourtListener bulk docket data',
    attribution: 'CourtListener / Free Law Project — Public Domain Mark.',
    // Said on every response, not just empty ones: a docket is the existence of
    // a case, and an agent that assumes otherwise will describe filings it has
    // never seen.
    scope_note:
      'Dockets record that a case exists — parties, court, dates, judge. They do NOT contain complaints, motions, orders or any filed document.',
    ...(removal?.attempted
      ? {
          removal_note:
            `A \`removed_from\` object on a docket means a Notice of Removal was filed on it, naming the state court and state docket number the case came from — ${removal.removed_from_returned} of ${removal.dockets_checked} docket(s) checked carried one. Its ABSENCE means no such notice was found, which is NOT evidence the case was not removed: the filing text comes from RECAP, which holds only dockets somebody has purchased or uploaded.${removal.notices_unparsed ? ` ${removal.notices_unparsed} notice(s) were found but carried no parseable state court and docket number, so no field was emitted for them rather than half of one.` : ''}${removal.not_checked ? ` ${removal.not_checked} returned docket(s) were not checked (the probe is capped at ${REMOVAL_MAX_DOCKETS} per call to stay inside an upstream rate limit of 5 requests/minute); treat those as unknown.` : ''}${removal.truncated ? ' An upstream page held more notices than it returned, so a removal on one of these dockets may have been missed.' : ''}${removal.error ? ` The lookup FAILED, so every missing removed_from on this response is unknown rather than negative: ${removal.error}` : ''}`,
        }
      : {}),
    ...(liveShown > 0
      ? {
          party_index_note:
            'Rows marked coverage:"live" carry a `parties` list and were matched on any named party, so a case captioned against an officer rather than the company appears there. Rows marked coverage:"mirror" are matched on the case name only and carry no party list — absence of a `parties` field is a property of that path, not of the case.',
        }
      : {}),
    ...(dockets.length === 0
      ? {
          found: false,
          ...(live?.error
            ? {
                reason: 'live_lookup_failed',
                hint: `No docket matched in CourtListener bulk data (which covers filings through ${horizonText}), AND the live CourtListener search could not be reached — so a case filed after that date is NOT ruled out by this result. Treat it as unknown and retry. Upstream said: ${live.error}`,
              }
            : {
                hint:
                  'No docket matched. Names are matched by word, so try one distinctive party alone ("Theranos" rather than a full caption). Consumer bankruptcy filings are deliberately excluded from this dataset.',
              }),
        }
      : {}),
  };
}

/** Word-matching name search against the FTS index. See searchDockets. */
async function rpc(m: DocketMirror, body: Record<string, unknown>): Promise<DocketRow[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${m.url}/rest/v1/rpc/search_dockets_by_name`, {
      method: 'POST',
      headers: {
        apikey: m.key,
        Authorization: `Bearer ${m.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as DocketRow[];

    const detail = (await res.text()).slice(0, 200);
    const timedOut = detail.includes('57014');
    // 57014 (statement_timeout) was NOT transient contention, whatever this
    // comment used to say — it was the query plan, fixed in migration 080. What
    // survives it is a genuinely cold first touch: a name matching tens of
    // thousands of dockets has to read that many heap pages, and the first read
    // of them can still run long while the same call moments later is warm. So
    // the retry stays, and the message no longer tells the caller their date
    // range is powerless — since 080 it is a real filter and does narrow the
    // scan.
    if (timedOut && attempt === 0) continue;
    if (timedOut) {
      throw new Error(
        'Docket name search timed out twice (Postgres 57014). The name matches enough dockets that reading them cold exceeds the statement timeout; the identical call usually succeeds moments later, so retry it as-is. Narrowing filed_after/filed_before, or giving one distinctive party word rather than a common one, reduces the work and makes it less likely.',
      );
    }
    throw new Error(`Docket name search failed (HTTP ${res.status}): ${detail}`);
  }
}

// ── Removal detection: removed_from ──────────────────────────────────
//
// A case removed from state to federal court is TWO records — a state docket
// and a federal one — and nothing on the federal docket says so. njd
// 2:26-cv-05788 is NS Pharma's removal of NJ Superior Court BER-C-000117-26,
// and its `cause` reads "09:1 U.S. Arbitration Act" (feedback #140, paid tier,
// 2026-10-08: the caller wants to link the two records).
//
// ROUTE TAKEN: parse the Notice of Removal out of the docket's own filings,
// which are keyless via /search/?type=rd. Verified live 2026-10-11 on that
// docket — the entry's description reads:
//
//   "NOTICE OF REMOVAL by NS Pharma, Inc., NIPPON SHINYAKU CO., LTD. from
//    Superior Court of New Jersey, Chancery Division: Bergen County, case
//    number BER-C-000117-26. ( Filing and Admin fee $ 405 ...)"
//
// THE ROUTE NOT TAKEN, and why: /api/rest/v4/dockets/ does carry a structured
// originating-court field, but it answers HTTP 401 — it needs a Free Law
// Project API token. That is an account credential, so minting it is Bruce's
// call and not a worker's, and the whole rest of this rail is deliberately
// keyless. A structured field would beat this text parse and is worth revisiting
// if a token is ever minted; it was not available to build against. Neither
// the bulk export (no removal column — see supabase/migrations/dockets_001_schema.sql)
// nor /search/?type=r (no originating_court_information, no appeal_from) has it.
//
// WHAT THIS COSTS, and why it is not per row. Three facts about the endpoint,
// all measured 2026-10-11:
//   - `docket_id:(a OR b OR c)` is honoured as a fielded Lucene term on
//     type=rd, so ONE request covers a whole page of dockets. A bogus id
//     (999999999) returned count:0, which is the control proving the field is
//     not being silently ignored the way /search/ ignores a bare docket_id
//     query parameter.
//   - Scoping to `short_description` rather than `description` returns exactly
//     the notice itself: 1 entry for that docket, against 5 for the description
//     field (the notice plus four exhibits that quote it). One entry per docket
//     is what makes the batch fit in one 20-row page.
//   - The throttle is 5 requests/MINUTE as well as ~125/day for a token-less
//     caller ("Rate limit exceeded: 5/min", hit while probing). That is why
//     this is capped rather than unbounded: at most 2 requests per call, on top
//     of the 1 the live fall-through may already have spent.
//
// ABSENCE IS NOT A NEGATIVE. RECAP holds only dockets somebody has bought or
// uploaded, so no Notice of Removal entry means "no notice found in RECAP",
// never "this case was not removed". That is said on every response that ran
// the lookup, because the two are the same missing field otherwise.
const CL_RD_SEARCH = 'https://www.courtlistener.com/api/rest/v4/search/';

/** How many returned dockets get the removal probe, and how many per request. */
const REMOVAL_MAX_DOCKETS = 20;
const REMOVAL_CHUNK = 10;

interface RemovedFrom {
  state_court: string;
  state_docket_number: string;
  notice_filed: string | null;
  notice_url: string | null;
  source: string;
}

interface RdRow {
  docket_id?: number | null;
  description?: string | null;
  short_description?: string | null;
  entry_date_filed?: string | null;
  absolute_url?: string | null;
}

/**
 * Pull the originating state court and its docket number out of a Notice of
 * Removal description.
 *
 * Returns null unless BOTH are found. A removal whose notice carries no text —
 * RECAP entries are sometimes bare — yields nothing here rather than half a
 * field, because "removed from somewhere, number unknown" is not linkable and
 * reads as data when it is not. The caller counts those separately so the gap
 * is visible instead of silent.
 *
 * The court name is captured non-greedily up to ", case number", which is what
 * lets it keep its own internal commas ("Superior Court of New Jersey,
 * Chancery Division: Bergen County").
 */
function parseRemovalNotice(description: string): { state_court: string; state_docket_number: string } | null {
  const m = /\bfrom\s+(.+?),\s*case\s+(?:number|no\.?)\s*([^\s,;]+)/i.exec(description);
  if (!m) return null;
  const court = m[1].replace(/\s+/g, ' ').trim();
  const number = m[2].replace(/[.,;]+$/, '').trim();
  if (!court || !number) return null;
  // A "court" that is really a sentence fragment is a mis-parse, not a court.
  if (court.length > 160 || !/court|division|tribunal|chancery|superior|circuit|district|county/i.test(court)) {
    return null;
  }
  return { state_court: court, state_docket_number: number };
}

interface RemovalLookup {
  attempted: boolean;
  dockets_checked: number;
  notices_found: number;
  removed_from_returned: number;
  /** A notice entry existed but carried no parseable state court + number. */
  notices_unparsed: number;
  /** Set when the probe was capped below the number of dockets returned. */
  not_checked?: number;
  /** Set when a page held more notices than it returned, so a docket may be missed. */
  truncated?: boolean;
  error?: string;
}

/**
 * Find the originating state court for each of `docketIds`.
 *
 * Throws nothing: a failure comes back as `lookup.error` so that a call the
 * docket data already answered is never failed by an annotation, while a
 * caller still cannot mistake "could not ask" for "not removed".
 */
async function removalLookups(
  docketIds: number[],
): Promise<{ byDocket: Map<number, RemovedFrom>; lookup: RemovalLookup }> {
  const ids = [...new Set(docketIds.filter((n) => Number.isInteger(n) && n > 0))];
  const checked = ids.slice(0, REMOVAL_MAX_DOCKETS);
  const byDocket = new Map<number, RemovedFrom>();
  const lookup: RemovalLookup = {
    attempted: checked.length > 0,
    dockets_checked: checked.length,
    notices_found: 0,
    removed_from_returned: 0,
    notices_unparsed: 0,
    ...(ids.length > checked.length ? { not_checked: ids.length - checked.length } : {}),
  };
  if (!checked.length) return { byDocket, lookup };

  for (let i = 0; i < checked.length; i += REMOVAL_CHUNK) {
    const chunk = checked.slice(i, i + REMOVAL_CHUNK);
    const params = new URLSearchParams({
      type: 'rd',
      q: `docket_id:(${chunk.join(' OR ')}) AND short_description:("notice of removal")`,
      order_by: 'entry_date_filed asc',
    });
    try {
      const res = await fetchWithTimeout(
        `${CL_RD_SEARCH}?${params}`,
        { headers: { Accept: 'application/json' } },
        'CourtListener removal lookup',
      );
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(
          res.status === 429
            ? `CourtListener's filing search is throttled for callers without an API token (5/minute, about 125/day) and that budget is currently spent (HTTP 429). This is an upstream rate limit, so a missing removed_from on this response means UNKNOWN, not "not removed".`
            : `CourtListener removal lookup failed (HTTP ${res.status}): ${body}`,
        );
      }
      const data = (await res.json()) as { count?: number; results?: RdRow[] };
      const rows = data.results ?? [];
      if (typeof data.count === 'number' && data.count > rows.length) lookup.truncated = true;
      for (const r of rows) {
        const id = r.docket_id;
        if (typeof id !== 'number' || byDocket.has(id)) continue;
        lookup.notices_found++;
        const parsed = parseRemovalNotice(r.description ?? '');
        if (!parsed) {
          lookup.notices_unparsed++;
          continue;
        }
        byDocket.set(id, {
          ...parsed,
          notice_filed: r.entry_date_filed ?? null,
          notice_url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
          source: 'Notice of Removal filed on the federal docket (CourtListener RECAP filing text)',
        });
      }
    } catch (err) {
      lookup.error = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  lookup.removed_from_returned = byDocket.size;
  return { byDocket, lookup };
}
/**
 * Federal criminal prosecutions — US federal court dockets.
 *
 * Covers US federal court dockets through the shared query layer
 * (see shared/src/dockets.ts). Separate pack rather than a filter argument
 * because tool selection is embedding cosine over descriptions: a description
 * written for THIS question matches it, and a generic docket description does
 * not.
 *
 * A docket records that a case exists. It contains no filings.
 */


const tools: McpToolExport['tools'] = [
  {
    name: 'federal_criminal_search',
    description:
      'Find US FEDERAL CRIMINAL PROSECUTIONS by defendant name. Searches federal district court dockets — cases captioned "United States v. ..." — no API key. Returns the case caption, docket number, district, filing date, termination date and assigned judge. Use for "has this person or company been federally charged", background and counterparty checks, and enforcement research. Returns the EXISTENCE of a prosecution, not the indictment or any filed document.',
    inputSchema: {
      type: 'object',
      properties: {
        defendant: { type: 'string', description: 'Defendant name or a distinctive part of it, e.g. "Holmes".' },
        court: { type: 'string', description: 'Optional federal district id, e.g. "cand", "nysd", "txwd".' },
        filed_after: { type: 'string', description: 'Only cases filed on or after this date, YYYY-MM-DD.' },
        filed_before: { type: 'string', description: 'Only cases filed on or before this date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Maximum dockets to return (1-50, default 10).' },
      },
      required: ['defendant'],
    },
  },
  {
    name: 'federal_criminal_recent',
    description:
      'List recent US federal criminal prosecutions, newest first, optionally limited to one district. No API key, no rate limit. Use for "what federal charges were filed recently" or to watch one district court.',
    inputSchema: {
      type: 'object',
      properties: {
        court: { type: 'string', description: 'Optional federal district id, e.g. "cand", "nysd", "txwd".' },
        filed_after: { type: 'string', description: 'Only cases filed on or after this date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Maximum dockets to return (1-50, default 20).' },
      },
    },
  },
];

const FILTERS = { court_class: 'federal_district', is_criminal: true };

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const m = docketMirror(args);
  if (!m) return docketUnavailable(name);

  switch (name) {
    case 'federal_criminal_search':
      return {
        query: args.defendant,
        ...(await searchDockets(m, FILTERS, {
          party: String(args.defendant ?? ''),
          court: args.court as string | undefined,
          filedAfter: args.filed_after as string | undefined,
          filedBefore: args.filed_before as string | undefined,
          limit: Number(args.limit) || 10,
        })),
      };

    case 'federal_criminal_recent':
      return searchDockets(m, FILTERS, {
        court: args.court as string | undefined,
        filedAfter: args.filed_after as string | undefined,
        limit: Number(args.limit) || 20,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
