# Dependency compatibility patches

Eve is pinned to the published `1.0.0-rc.1` release.

`eve@1.0.0-rc.1.patch` preserves native Linq replies. Eve bundles its own copy
of the Linq Chat SDK adapter, which does not forward a reply target. The patch
adds `replyToMessageId` to the bundled adapter's `LinqSendOptions` and forwards
it to Linq as `reply_to`. This app no longer has a Linq channel, so the patched
code never runs; the patch stays so the pinned Eve install is unchanged. Remove
it with the next Eve upgrade.

The earlier `task_cancel` hunk is no longer needed: Eve 1.0 provides
`eve__task_cancel` itself for agents with task tools, including the resumable
`run_browser` tool.

`@onkernel__browser-loop@0.12.0.patch` adds `BrowserExecutor.linkAddress(ref,
tabId, signal)` to the built package (`dist/`, with its type). Browser Loop's
snapshots and find results show a link's role and name but never its address,
and `save_file` needs the address: without this the worker guessed addresses
and fetched 404s. The method takes the same steps as a fill (the tab, the
document reconcile, the ref's generation and session), in the ref's own tab
unless one is named, then reads the resolved `href` of the element or its
nearest enclosing link; an empty or fragment-only `href` counts as no address.
It throws Browser Loop's stale-ref error, never answering for another element,
when the node is gone or no longer in the page, when the ref's generation
changed while it was read, or when an earlier action healed the ref onto
another element with the same role and name: the patch records the node each
ref was minted for (`mintedNodeId`), and a heal moves only `backendNodeId`.
`src/` is left as published. Carry the method over, or drop the patch if Browser Loop ships its
own, with the next Browser Loop upgrade; pnpm refuses to install a patch that
no longer applies.
