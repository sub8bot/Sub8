# @sub8/web-fetch

Outbound HTTP from the host. Two entry points, one guard:

| import | was | owns |
| --- | --- | --- |
| `@sub8/web-fetch` | `server/web-fetch.mjs` | `assertPublicHttpUrl`, `webFetch`, `htmlToMarkdown` |
| `@sub8/web-fetch/mcp-remote` | `server/mcp-remote.mjs` | user-added remote MCP servers and their tokens |

They live together because `assertMcpUrl` **is** `assertPublicHttpUrl`. Both are
places where a URL the model chose makes this machine open a socket, so both go
through the same blocklist.

## The blocklist is the point

`web_fetch` and `add_mcp_server` are the two tools that turn model output into a
request from the user's own machine. That machine can reach things the model
must not: `127.0.0.1:8787` (this app's API), the desk's noVNC port, a home
router, `169.254.169.254`. So `assertPublicHttpUrl` refuses:

- anything that is not `http:` / `https:` (`file:` gets its own message)
- `localhost`, `*.localhost`, `ip6-localhost`, `::1`, `0.0.0.0`, `::`, `0`
- `metadata.google.internal`
- RFC1918 (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`), link-local
  (`169.254/16`), and IPv6 ULA/link-local (`fc00::/7`, `fe80::/10`)
- URLs carrying credentials

Redirects are followed **by hand** (`redirect: "manual"`) precisely so every hop
is re-checked. A public URL that 302s to `169.254.169.254` is refused at the
second hop, not followed.

### Spellings, not just addresses

The guard runs on `URL.hostname`, so it sees what the WHATWG parser produced,
not what the model typed. `http://127.1/`, `http://2130706433/` and
`http://0177.0.0.1/` all arrive as `127.0.0.1` and are caught for free — but
`http://[::ffff:127.0.0.1]/` arrives as `::ffff:7f00:1`, and the original
`/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` never matched it. That let the whole private
range through. `mappedIpv4()` folds both spellings to a dotted quad first.

The lesson is the same one `packages/constants/README.md` records about
`\bsqlite\b` not matching `sqlite3`: match the form the machine normalises to,
not the form a human writes.

## Injection, not mocking

`webFetch(url, { fetch })` and `setFetch(fn)` take the transport as an argument.
No network in the tests, and no `nock`-style patching of globals.

## What is deliberately NOT here

- **`server/read-file.mjs`.** It re-exports all three functions because the
  `read` tool takes a path *or* a URL, but its own job is desk paths.
- **The choice card.** `connectCard` returns a plain `secret-request` object;
  `@sub8/choice` is what turns it into a card. This package does not import it
  (the tests do).
