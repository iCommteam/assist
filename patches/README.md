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
