# @sub8/harness-plugins

What plugins/connectors each harness exposes and whether they are connected,
through one shape the app can render regardless of how a harness reports them.

## Shape

- `HarnessPlugin` — one plugin: `id`, `name`, `harness`, `url`, `transport`,
  normalized `status` (`connected | needs_auth | error | unknown`), the raw
  `detail`, and a `connectUrl` to send the user to when it is not connected.
- `HarnessExec` — runs a command wherever the harness actually lives (the Mac
  host for a local desk, the droplet for a cloud desk). It is **injected**, so
  a provider stays pure and the same code works everywhere a harness can run.
- `HarnessPluginProvider` — one per harness: `listPlugins(exec)` and
  `connectUrl(plugin)`.

## Registry

`pluginsForHarness(id)` returns a harness's provider or `null` when that
harness has no plugin surface yet. Adding a harness is one entry in
`PLUGIN_PROVIDERS` plus its provider module — nothing else changes.

## Claude (first provider)

Claude Code lists its MCP servers/connectors with `claude mcp list`, and that
output already carries each one's live status:

```
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:stripe:stripe: https://mcp.stripe.com (HTTP) - ! Needs authentication
```

`parseClaudeMcpList` is a pure parser over that (unit-tested against real
output). A name may itself contain colons, so the name/url split is the `": "`
right before the URL, not the first colon. Not-connected plugins point at the
claude.ai connectors page.
