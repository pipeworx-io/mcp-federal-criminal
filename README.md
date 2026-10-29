# Federal criminal prosecutions

Federal criminal prosecutions — cases captioned `United States v. ...` in US federal district courts. **68.8% of federal district dockets are criminal**, which is what makes this a pack rather than a filter.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

No API key.

## What this is, and what it is not

**Docket metadata**: that a case exists, its parties, court, docket number,
filing and termination dates, and assigned judge. It contains **no filings** —
no complaints, motions, briefs or orders. Those are RECAP, a separate corpus
that is not keyless.

An agent with this data knows a case was brought. It does not know what anyone
argued.

## Tools

| Tool | Returns |
|---|---|
| `federal_criminal_search` | Dockets matching a party name |
| `federal_criminal_recent` | Recent dockets, newest first |

## Caveats

- **Quarterly snapshot.** Every response carries `snapshot_date`.
- **`date_terminated` is 78.3% filled**, so a missing date means *not recorded*,
  never *still open*. Responses say which.
- **`nature_of_suit` is sparse** — 14.8% corpus-wide, 30.5% in district courts.
  This can tell you a company is in federal court; it often cannot tell you what
  for.
- Party search matches a substring of the case caption, so a distinctive party
  name works better than a full caption.

## Attribution

Data is CourtListener / Free Law Project, published under the Public Domain
Mark. Free Law Project funds and maintains the corpus. If this pack is useful
to you, <https://free.law/donate/> is where that goes.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "federal-criminal": {
      "url": "https://gateway.pipeworx.io/federal-criminal/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/federal-criminal/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/federal_criminal_search \
  -H 'Content-Type: application/json' \
  -d '{"defendant":"Holmes","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/federal_criminal_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-federal-criminal` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/federal-criminal/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "federal-criminal": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-federal-criminal"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Federal Criminal data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
