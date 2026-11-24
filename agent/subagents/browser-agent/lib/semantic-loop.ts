import {
  LoopExecutionResources,
  type BrowserRefState,
  type LoopToolExecutionResult,
  type LoopToolSpec,
} from "@onkernel/browser-loop";
import { defineState } from "eve/context";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";

/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- Browser Loop's materialized vendor tool accepts arbitrary JSON input by contract. */

const resourcesBySession = new Map<string, LoopExecutionResources>();
const lockTailsBySession = new Map<string, Promise<void>>();
const refStates = defineState<Record<string, BrowserRefState>>(
  "worker.browser-loop.refs",
  () => ({})
);

export async function executeBrowserLoopTool(
  sessionId: string,
  spec: LoopToolSpec,
  input: Record<string, unknown>,
  signal?: AbortSignal
) {
  return withBrowserLoopSessionLock(sessionId, async () => {
    const resources = await resourcesFor(sessionId, signal);
    let output: LoopToolExecutionResult | undefined;

    try {
      output = await resources.materialize(spec).execute(input, signal);
    } finally {
      const state = resources.browserExecutor().exportRefState();
      refStates.update((current) => ({ ...current, [sessionId]: state }));
    }

    return output;
  });
}

// The address of the link a ref names, read through Browser Loop's own ref
// checks (patches/README.md). The caller holds the browser's lock, so the
// address is read and used in one hold of it.
export async function linkAddressHeld(
  sessionId: string,
  ref: string,
  tabId: string | undefined,
  signal?: AbortSignal
) {
  const resources = await resourcesFor(sessionId, signal);
  const executor = resources.browserExecutor();
  try {
    return await executor.linkAddress(ref, tabId, signal);
  } finally {
    const state = executor.exportRefState();
    refStates.update((current) => ({ ...current, [sessionId]: state }));
  }
}

export async function disposeBrowserLoopSession(sessionId: string) {
  await withBrowserLoopSessionLock(sessionId, async () => {
    const resources = resourcesBySession.get(sessionId);
    resourcesBySession.delete(sessionId);
    refStates.update((current) => {
      const { [sessionId]: _removed, ...remaining } = current;
      return remaining;
    });
    await resources?.dispose();
  });
}

export function modelText(output: LoopToolExecutionResult) {
  return output.content
    .map((part) =>
      part.type === "text"
        ? part.text
        : `[${part.mimeType} image omitted from text output]`
    )
    .join("\n");
}

async function resourcesFor(sessionId: string, signal?: AbortSignal) {
  const cached = resourcesBySession.get(sessionId);
  if (cached) return cached;

  const browser = await kernel.browsers.retrieve(sessionId, {}, { signal });

  type Options = ConstructorParameters<typeof LoopExecutionResources>[0];
  const resources = new LoopExecutionResources({
    browser,
    // SAFETY: Browser Loop pins an older nominal Kernel SDK type, while the shared client is API-compatible with that exact runtime contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the assertion bridges duplicate nominal SDK installations at the vendor boundary
    client: kernel as unknown as Options["client"],
  });
  const refState = refStates.get()[sessionId];
  if (refState) {
    resources.browserExecutor().importRefState(refState);
  }
  resourcesBySession.set(sessionId, resources);
  return resources;
}

// One Browser Loop action per browser at a time. save_file holds it as well
// while its download tab is open, so no tab list shows that tab.
export async function withBrowserLoopSessionLock<T>(
  sessionId: string,
  operation: () => Promise<T>
) {
  const previous = lockTailsBySession.get(sessionId) ?? Promise.resolve();
  let release: () => void = noop;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  lockTailsBySession.set(sessionId, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (lockTailsBySession.get(sessionId) === tail) {
      lockTailsBySession.delete(sessionId);
    }
  }
}

function noop() {
  return undefined;
}
