import { defineState } from "eve/context";
import type { BrowserPageState } from "@agent/subagents/browser-agent/lib/policy/page-check";

// Keeps values injected by fill_from_vault out of everything a worker returns:
// tool results (which eve stores and the model reads), error messages and
// browser traces.
//
// The values themselves live only in this process, keyed by worker session,
// never in eve state. What survives a restart is the non-secret fact that a
// browser was filled: while the filled document may still be open, every
// `value="..."` attribute in a snapshot is stripped, whether or not the values
// are still known. A restart therefore fails closed.

const injectedValues = new Map<string, Set<string>>();
// One-time codes, also hidden when a page shows them split, one character per
// box or slot: the snapshot then lists each character on its own line.
const injectedCodes = new Map<string, Set<string>>();

// Browser session ID -> performance.timeOrigin of each document open when the
// fill ran, or null when that is unknown (strip until the browser is deleted).
const filledDocuments = defineState<Record<string, readonly number[] | null>>(
  "worker.vault-fill.documents",
  () => ({})
);
// Browsers whose filled documents include a one-time code. A code widget may
// draw the code outside any input, where no mask reaches, so screenshots of
// those documents are withheld until they are gone.
const codeDocuments = defineState<Record<string, true>>(
  "worker.vault-fill.code-documents",
  () => ({})
);

const minimumRedactedLength = 4;
// Browser Loop renders a control's value as value="..." (JSON-escaped). Trace
// rows hold that text JSON-escaped once more: value=\"...\".
const renderedValue = /value="(?:[^"\\]|\\.)*"/gu;
const escapedRenderedValue = /value=\\"(?:[^"\\]|\\\\(?:\\["\\]|[^"\\]))*\\"/gu;
const hiddenValue = 'value="[hidden]"';
const escapedHiddenValue = String.raw`value=\"[hidden]\"`;
const hiddenText = "[vault value hidden]";

export function rememberInjectedValues(
  workerSessionId: string,
  browserSessionId: string,
  values: readonly string[]
) {
  const known = injectedValues.get(workerSessionId) ?? new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length >= minimumRedactedLength) known.add(trimmed);
  }
  injectedValues.set(workerSessionId, known);
  markFilledBrowser(browserSessionId);
}

export function rememberInjectedCode(
  workerSessionId: string,
  browserSessionId: string,
  code: string
) {
  rememberInjectedValues(workerSessionId, browserSessionId, [code]);
  const trimmed = code.trim();
  if (trimmed.length >= minimumRedactedLength) {
    const known = injectedCodes.get(workerSessionId) ?? new Set<string>();
    known.add(trimmed);
    injectedCodes.set(workerSessionId, known);
  }
  markCodeFilledBrowser(browserSessionId);
}

// Marks a browser as showing a filled one-time code, also where the code
// itself is not at hand, such as after a fill in a workflow step.
export function markCodeFilledBrowser(browserSessionId: string) {
  markFilledBrowser(browserSessionId);
  codeDocuments.update((current) => ({
    ...current,
    [browserSessionId]: true,
  }));
}

function markFilledBrowser(browserSessionId: string) {
  filledDocuments.update((current) => ({
    ...current,
    [browserSessionId]: null,
  }));
}

export const codeScreenshotWithheld =
  "The screenshot was withheld because the page holds a filled one-time code. Use browser_snapshot until the page changes.";

// Whether a document a one-time code was filled into may still be open.
export function showsFilledCode(browserSessionId: string) {
  return (
    browserSessionId in codeDocuments.get() &&
    browserSessionId in filledDocuments.get()
  );
}

export function recordFilledDocuments(
  browserSessionId: string,
  pages: readonly BrowserPageState[]
) {
  // A tab that could not be read may be the filled document, so one unknown
  // tab makes every document unknown.
  const unknown = pages.some((page) => page.timeOrigin === null);
  const origins = pages.flatMap((page) =>
    page.timeOrigin === null ? [] : [page.timeOrigin]
  );
  filledDocuments.update((current) => ({
    ...current,
    [browserSessionId]: !unknown && origins.length > 0 ? origins : null,
  }));
}

// Ends value stripping once every document that was open at fill time has
// been replaced by a navigation. A tab that could not be read never counts as
// replaced.
export function releaseNavigatedDocuments(
  browserSessionId: string,
  pages: readonly BrowserPageState[]
) {
  const filled = filledDocuments.get()[browserSessionId];
  if (!filled) return;
  if (pages.some((page) => page.timeOrigin === null)) return;
  const open = new Set(pages.map((page) => page.timeOrigin));
  if (filled.some((origin) => open.has(origin))) return;
  forgetFilledBrowser(browserSessionId);
}

export function forgetFilledBrowser(browserSessionId: string) {
  filledDocuments.update((current) => {
    const { [browserSessionId]: _removed, ...remaining } = current;
    return remaining;
  });
  codeDocuments.update((current) => {
    const { [browserSessionId]: _removed, ...remaining } = current;
    return remaining;
  });
}

export function forgetInjectedValues(workerSessionId: string) {
  injectedValues.delete(workerSessionId);
  injectedCodes.delete(workerSessionId);
}

// Redacts a worker tool result for one browser. Image data is left alone.
export function redactBrowserOutput<T>(
  workerSessionId: string,
  browserSessionId: string,
  output: T
): T {
  const stripRendered = browserSessionId in filledDocuments.get();
  return mapStrings(output, (text) =>
    redact(workerSessionId, text, stripRendered)
  );
}

// Redacts trace data for a worker, stripping rendered values while any of its
// browsers may still show a filled document. Run it before the data is
// serialized or truncated, so a cut-off value cannot escape the patterns.
export function redactWorkerOutput<T>(workerSessionId: string, value: T): T {
  const stripRendered = Object.keys(filledDocuments.get()).length > 0;
  return mapStrings(value, (text) =>
    redact(workerSessionId, text, stripRendered)
  );
}

function redact(workerSessionId: string, text: string, stripRendered: boolean) {
  let result = stripRendered
    ? text
        .replace(escapedRenderedValue, escapedHiddenValue)
        .replace(renderedValue, hiddenValue)
    : text;
  for (const value of injectedValues.get(workerSessionId) ?? []) {
    for (const variant of new Set([
      value,
      JSON.stringify(value).slice(1, -1),
    ])) {
      result = result.replace(
        new RegExp(escapeRegExp(variant), "giu"),
        hiddenText
      );
    }
  }
  for (const code of injectedCodes.get(workerSessionId) ?? []) {
    result = redactSplitCode(result, code);
  }
  return result;
}

const maxSplitGap = 80;
const splitSeparatorWords = ["StaticText", "generic"];

// Hides a code whose characters appear in order with only separators between
// them: whitespace, punctuation, escapes such as \n, a bracketed annotation
// such as [cursor:pointer], or the snapshot's role name for a bare text line.
// A linear scan rather than a regular expression, so a long page cannot make
// it backtrack.
function redactSplitCode(text: string, code: string) {
  const characters = code.split("");
  let result = "";
  let copied = 0;
  let start = 0;
  while (start < text.length) {
    const end = splitCodeEnd(text, start, characters);
    if (end === undefined) {
      start += 1;
      continue;
    }
    result += `${text.slice(copied, start)}${hiddenText}`;
    copied = end;
    start = end;
  }
  return copied === 0 ? text : `${result}${text.slice(copied)}`;
}

// The end of the split code that starts at `start`, or undefined.
function splitCodeEnd(
  text: string,
  start: number,
  characters: readonly string[]
) {
  let position = start;
  for (const [index, character] of characters.entries()) {
    const gapStart = position;
    while (!sameText(text, position, character)) {
      const next = index === 0 ? undefined : afterSeparator(text, position);
      if (next === undefined || next - gapStart > maxSplitGap) return undefined;
      position = next;
    }
    position += character.length;
  }
  return position;
}

function sameText(text: string, position: number, expected: string) {
  return (
    text.slice(position, position + expected.length).toLowerCase() ===
    expected.toLowerCase()
  );
}

function afterSeparator(text: string, position: number) {
  const character = text[position];
  if (character === undefined) return undefined;
  for (const word of splitSeparatorWords) {
    if (sameText(text, position, word)) return position + word.length;
  }
  if (character === "\\" && /[nrt]/u.test(text[position + 1] ?? "")) {
    return position + 2;
  }
  if (character === "[") {
    const close = text.indexOf("]", position);
    const annotation = close === -1 ? "" : text.slice(position, close);
    if (close !== -1 && close - position <= 40 && !annotation.includes("\n")) {
      return close + 1;
    }
  }
  return /[\p{L}\p{N}]/u.test(character) ? undefined : position + 1;
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Browser Loop results carry arbitrary vendor JSON, so redaction walks every string in it. */
function mapStrings<T>(value: T, transform: (text: string) => string): T {
  const visit = (
    entry: unknown,
    key?: string,
    parentType?: unknown
  ): unknown => {
    if (typeof entry === "string") {
      return key === "data" && parentType === "image"
        ? entry
        : transform(entry);
    }
    if (Array.isArray(entry)) return entry.map((item) => visit(item));
    if (typeof entry === "object" && entry !== null) {
      const record: [string, unknown][] = Object.entries(entry);
      const type = record.find(([name]) => name === "type")?.[1];
      return Object.fromEntries(
        record.map(([name, item]) => [name, visit(item, name, type)])
      );
    }
    return entry;
  };
  // SAFETY: visit only replaces strings with strings, so the shape of T is kept.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structure-preserving string map over a vendor result
  return visit(value) as T;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
