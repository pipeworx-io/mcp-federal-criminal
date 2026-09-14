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
  };
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
      `Docket mirror query failed (HTTP ${res.status}) against ${m.url.replace(/https?:\/\//, '').split('.')[0]}: ${body}`,
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
  // A date window beyond the mirror's snapshot returns 0 rows as a clean
  // success — "securities class actions filed after 2026-07-24" answered
  // "none exist" when the truth was "the snapshot ends earlier" (fleet #508's
  // verbatim question died here after the routing fix). On a dated empty,
  // retry once WITHOUT the dates: if data exists, return the newest the
  // mirror holds and say the window outran the snapshot — the caller learns
  // the mirror's horizon instead of a false negative.
  let dateWindowNote: string | undefined;
  if (rows.length === 0 && (s.filedAfter || s.filedBefore)) {
    const undated = await fetchRows(undefined, undefined);
    if (undated.length > 0) {
      rows = undated;
      dateWindowNote =
        `No dockets matched within the requested date window (${s.filedAfter ?? ''}..${s.filedBefore ?? ''}) — the mirror's newest matching docket is ${undated[0]?.date_filed ?? 'unknown'}, so the window likely outran the snapshot. Returning the newest matching dockets the mirror holds; treat absence WITHIN the window as UNKNOWN, not as zero filings.`;
    }
  }

  return {
    returned: rows.length,
    dockets: rows.map(shapeDocket),
    ...(dateWindowNote ? { date_window_note: dateWindowNote } : {}),
    snapshot_date: rows[0]?.snapshot_date ?? null,
    source: 'pipeworx mirror of CourtListener bulk data',
    attribution: 'CourtListener / Free Law Project — Public Domain Mark.',
    // Said on every response, not just empty ones: a docket is the existence of
    // a case, and an agent that assumes otherwise will describe filings it has
    // never seen.
    scope_note:
      'Dockets record that a case exists — parties, court, dates, judge. They do NOT contain complaints, motions, orders or any filed document.',
    ...(rows.length === 0
      ? {
          found: false,
          hint: 'No docket matched. Names are matched by word, so try one distinctive party alone ("Theranos" rather than a full caption). Consumer bankruptcy filings are deliberately not mirrored.',
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
