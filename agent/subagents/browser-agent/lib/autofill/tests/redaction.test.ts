import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEveState } from "@tests/helpers/eve-state";
import type { BrowserPageState } from "@agent/subagents/browser-agent/lib/policy/page-check";
import {
  forgetFilledBrowser,
  forgetInjectedValues,
  markCodeFilledBrowser,
  recordFilledDocuments,
  redactBrowserOutput,
  redactWorkerOutput,
  releaseNavigatedDocuments,
  rememberInjectedCode,
  rememberInjectedValues,
  showsFilledCode,
} from "../redaction";

vi.mock("eve/context", () => import("@tests/helpers/eve-state"));

const password = 'hunter2-"quoted"-pass';
const snapshot =
  '- textbox "Email" [ref=e1] value="alice@example.com"\n- textbox "Password" [ref=e2] value="hunter2-\\"quoted\\"-pass"\n- textbox "Search" [ref=e3] value="mugs"';

function openDocuments(...origins: number[]): BrowserPageState[] {
  return origins.map((timeOrigin) => ({
    frames: [],
    status: 200,
    text: "",
    timeOrigin,
    title: "",
    url: "https://login.example.com/",
  }));
}

// A tab whose evaluate threw or timed out during the page check.
const unreadTab: BrowserPageState = {
  frames: [],
  status: null,
  text: "",
  timeOrigin: null,
  title: "",
  url: "https://login.example.com/",
};

beforeEach(() => {
  resetEveState();
  forgetInjectedValues("worker-1");
  forgetInjectedValues("worker-2");
});

describe("vault value redaction", () => {
  it("strips every rendered value until the filled document navigates away", () => {
    rememberInjectedValues("worker-1", "browser-1", [
      "alice@example.com",
      password,
    ]);
    recordFilledDocuments("browser-1", openDocuments(1_000));

    const filled = redactBrowserOutput("worker-1", "browser-1", snapshot);
    expect(filled).not.toContain("alice@example.com");
    expect(filled).not.toContain("hunter2");
    expect(filled).not.toContain("mugs");
    expect(filled).toContain('value="[hidden]"');

    releaseNavigatedDocuments("browser-1", openDocuments(1_000, 2_000));
    expect(
      redactBrowserOutput("worker-1", "browser-1", snapshot)
    ).not.toContain("mugs");

    releaseNavigatedDocuments("browser-1", openDocuments(2_000));
    const navigated = redactBrowserOutput("worker-1", "browser-1", snapshot);
    // Known values stay hidden after navigation; other values show again.
    expect(navigated).toContain('value="mugs"');
    expect(navigated).not.toContain("alice@example.com");
    expect(navigated).not.toContain("hunter2");
    expect(navigated).toContain("[vault value hidden]");
  });

  it("fails closed when the filled documents are unknown, as after a restart", () => {
    rememberInjectedValues("worker-1", "browser-1", [password]);
    // The values are lost (a new process); the durable fill flag remains.
    forgetInjectedValues("worker-1");

    releaseNavigatedDocuments("browser-1", openDocuments(9_000));
    expect(
      redactBrowserOutput("worker-1", "browser-1", snapshot)
    ).not.toContain("hunter2");

    forgetFilledBrowser("browser-1");
    expect(redactBrowserOutput("worker-1", "browser-1", snapshot)).toContain(
      "hunter2"
    );
  });

  it("never counts a tab that could not be read as replaced", () => {
    rememberInjectedValues("worker-1", "browser-1", [password]);
    recordFilledDocuments("browser-1", openDocuments(1_000));

    // The filled document's tab is mid-navigation or hung: no timeOrigin.
    releaseNavigatedDocuments("browser-1", [
      ...openDocuments(2_000),
      unreadTab,
    ]);
    expect(
      redactBrowserOutput("worker-1", "browser-1", snapshot)
    ).not.toContain("mugs");

    releaseNavigatedDocuments("browser-1", openDocuments(2_000));
    expect(redactBrowserOutput("worker-1", "browser-1", snapshot)).toContain(
      'value="mugs"'
    );
  });

  it("strips until the browser is deleted when a tab was unreadable at fill time", () => {
    rememberInjectedValues("worker-1", "browser-1", [password]);
    recordFilledDocuments("browser-1", [...openDocuments(1_000), unreadTab]);

    // Every recorded document is gone, but the unread tab may have held the
    // fill, so stripping continues.
    releaseNavigatedDocuments("browser-1", openDocuments(2_000));
    expect(
      redactBrowserOutput("worker-1", "browser-1", snapshot)
    ).not.toContain("mugs");

    forgetFilledBrowser("browser-1");
    expect(redactBrowserOutput("worker-1", "browser-1", snapshot)).toContain(
      'value="mugs"'
    );
  });

  it("matches values case-insensitively and in JSON-escaped form across a nested result", () => {
    rememberInjectedValues("worker-1", "browser-1", [
      "Alice@Example.com",
      password,
    ]);
    forgetFilledBrowser("browser-1");

    const output = redactBrowserOutput("worker-1", "browser-1", {
      content: [
        { text: "Signed in as ALICE@example.com", type: "text" },
        { data: "aGVsbG8=", mimeType: "image/png", type: "image" },
      ],
      details: {
        readResults: [
          {
            result: { successor: { text: snapshot } },
            type: "browser_act",
          },
        ],
        statusText: "ok",
      },
    });

    const serialized = JSON.stringify(output);
    expect(serialized).not.toMatch(/alice@example\.com/iu);
    expect(serialized).not.toContain("hunter2");
    expect(output.content[1]).toEqual({
      data: "aGVsbG8=",
      mimeType: "image/png",
      type: "image",
    });
  });

  it("keeps each worker's values to its own output and skips very short values", () => {
    rememberInjectedValues("worker-1", "browser-1", ["abc", password]);
    forgetFilledBrowser("browser-1");

    expect(redactWorkerOutput("worker-2", `typed ${password}`)).toContain(
      "hunter2"
    );
    expect(redactWorkerOutput("worker-1", `typed ${password} abc`)).toBe(
      "typed [vault value hidden] abc"
    );
  });

  it("strips rendered values from trace text while any browser may show a fill", () => {
    rememberInjectedValues("worker-1", "browser-1", [password]);
    expect(redactWorkerOutput("worker-1", 'value="mugs"')).toBe(
      'value="[hidden]"'
    );
    // Trace rows carry the text JSON-escaped once more.
    const escaped = JSON.stringify({
      text: 'textbox [ref=e1] value="say \\"hi\\" \\ ok" next value="x"',
    });
    const redacted = redactWorkerOutput("worker-1", escaped);
    expect(redacted).not.toContain("say");
    expect(JSON.parse(redacted)).toEqual({
      text: 'textbox [ref=e1] value="[hidden]" next value="[hidden]"',
    });
    forgetFilledBrowser("browser-1");
    expect(redactWorkerOutput("worker-1", 'value="mugs"')).toBe('value="mugs"');
  });

  it("hides a one-time code that a widget shows one character per slot", () => {
    rememberInjectedCode("worker-1", "browser-1", "482913");
    const slots = [
      '  textbox "Verification code" [ref=e4]',
      '  StaticText "4"',
      '  StaticText "8"',
      '  StaticText "2"',
      '  StaticText "-"',
      '  StaticText "9"',
      '  StaticText "1"',
      '  StaticText "3"',
      '  button "Verify" [ref=e5]',
    ].join("\n");

    // The code is known, so it is found across the lines wherever it shows.
    expect(redactBrowserOutput("worker-1", "browser-2", slots)).toBe(
      '  textbox "Verification code" [ref=e4]\n  StaticText "[vault value hidden]"\n  button "Verify" [ref=e5]'
    );
    expect(
      redactBrowserOutput("worker-1", "browser-2", "Code: 4 8 2 9 1 3.")
    ).toBe("Code: [vault value hidden].");
    // In the browser it was filled into, each character line is hidden too.
    expect(redactBrowserOutput("worker-1", "browser-1", slots)).not.toMatch(
      /"[4829136-]"/u
    );
    // Trace rows carry the snapshot JSON-escaped once more.
    expect(
      redactWorkerOutput("worker-1", JSON.stringify({ text: slots }))
    ).not.toMatch(/4.*8.*2.*9.*1.*3/su);
  });

  it("leaves refs and other figures alone when they do not spell the code", () => {
    rememberInjectedCode("worker-1", "browser-1", "482913");
    const page =
      '  button "Page 4" [ref=e8]\n  StaticText "Invoice 2913, due 8 Dec"\n  link "Download" [ref=e9]';

    expect(redactBrowserOutput("worker-1", "browser-1", page)).toBe(page);
  });

  it("hides each box's character of a split code field, even once the code is forgotten", () => {
    const boxes = [1, 2, 3]
      .map(
        (box) =>
          `  textbox "Digit ${String(box)}" [ref=e${String(box + 3)}] [value="${"482"[box - 1] ?? ""}"]\n    StaticText "${"482"[box - 1] ?? ""}"`
      )
      .join("\n");
    rememberInjectedCode("worker-1", "browser-1", "482913");
    forgetInjectedValues("worker-1");

    const redacted = redactBrowserOutput("worker-1", "browser-1", boxes);

    expect(redacted).not.toMatch(/"[482]"/u);
    expect(redacted).toContain('textbox "Digit 2" [ref=e5]');
    expect(redacted).toContain('StaticText "[hidden]"');
    // Text output with one character per line, as slot widgets give.
    expect(redactBrowserOutput("worker-1", "browser-1", "Code\n4\n8\n2")).toBe(
      "Code\n[hidden]\n[hidden]\n[hidden]"
    );
    // A trace row carries the snapshot JSON-escaped once more.
    expect(
      redactWorkerOutput("worker-1", JSON.stringify({ text: boxes }))
    ).not.toMatch(/StaticText \\"[482]\\"/u);

    // Pages without a filled code keep their one-character text.
    expect(redactBrowserOutput("worker-1", "browser-2", boxes)).toContain(
      'StaticText "8"'
    );
  });

  it("marks a browser that shows a filled code until its document is gone", () => {
    markCodeFilledBrowser("browser-1");
    expect(showsFilledCode("browser-1")).toBe(true);
    expect(showsFilledCode("browser-2")).toBe(false);

    recordFilledDocuments("browser-1", openDocuments(1_000));
    releaseNavigatedDocuments("browser-1", openDocuments(1_000));
    expect(showsFilledCode("browser-1")).toBe(true);
    releaseNavigatedDocuments("browser-1", openDocuments(2_000));
    expect(showsFilledCode("browser-1")).toBe(false);

    // A later password fill is not a code fill.
    rememberInjectedValues("worker-1", "browser-1", [password]);
    expect(showsFilledCode("browser-1")).toBe(false);
    markCodeFilledBrowser("browser-1");
    forgetFilledBrowser("browser-1");
    expect(showsFilledCode("browser-1")).toBe(false);
  });
});
