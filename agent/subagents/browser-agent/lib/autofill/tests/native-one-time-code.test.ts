import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { assertKernelOneTimeCodeFocus, fillKernelOneTimeCode } from "../native";
import {
  frameOriginExpression,
  nativeLoginControlInspectionExpression,
  type NativeLoginControlDescriptor,
} from "../login";

vi.mock("@onkernel/sdk", () => ({
  default: class {
    browsers = { retrieve: async () => ({ cdp_ws_url: "wss://kernel.test" }) };
  },
}));

const commandSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.json()).optional(),
  sessionId: z.string().optional(),
});
const commands: z.infer<typeof commandSchema>[] = [];

class CodeInput {
  readonly dataset: Record<string, string> = {};
  readonly #accept: (next: string) => string;
  #value = "";

  // What the page keeps of a value written into the field.
  constructor(accept: (next: string) => string = (next) => next) {
    this.#accept = accept;
  }

  get value() {
    return this.#value;
  }

  set value(next: string) {
    this.#value = this.#accept(next);
  }

  click() {
    return undefined;
  }

  focus() {
    return undefined;
  }

  dispatchEvent() {
    return true;
  }
}
class FakeEvent {
  readonly bubbles = true;
}

let pageOrigin = "https://login.vendor.example";
let frameOrigin = pageOrigin;
let controls: NativeLoginControlDescriptor[] = [];
let inputs: CodeInput[] = [];

class BrowserSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  send(data: string) {
    const command = commandSchema.parse(JSON.parse(data));
    commands.push(command);
    let result = {};
    switch (command.method) {
      case "Target.getTargets":
        result = {
          targetInfos: [
            { targetId: "page-1", type: "page", url: `${pageOrigin}/mfa` },
          ],
        };
        break;
      case "Target.attachToTarget":
        result = { sessionId: "cdp-1" };
        break;
      case "Page.getFrameTree":
        result = {
          frameTree: { frame: { id: "frame-1", url: `${frameOrigin}/mfa` } },
        };
        break;
      case "Page.createIsolatedWorld":
        result = { executionContextId: 1 };
        break;
      case "Runtime.evaluate": {
        const expression = z.string().parse(command.params?.expression);
        if (expression === frameOriginExpression) {
          result = { result: { value: frameOrigin } };
        } else if (expression === nativeLoginControlInspectionExpression) {
          result = { result: { value: controls } };
        } else {
          const index = /item\((?<index>\d+)\)/u.exec(expression)?.groups
            ?.index;
          result = { result: { objectId: `input-${index ?? ""}` } };
        }
        break;
      }
      case "Runtime.callFunctionOn": {
        const objectId = z.string().parse(command.params?.objectId);
        const [code, expectedOrigin] = z
          .array(z.object({ value: z.string() }))
          .parse(command.params?.arguments)
          .map(({ value }) => value);
        const input = inputs[Number(objectId.replace("input-", ""))];
        result = {
          result: {
            value: z.boolean().parse(
              runInNewContext(
                `(${z.string().parse(command.params?.functionDeclaration)}).call(input, code, expectedOrigin)`,
                {
                  code,
                  Event: FakeEvent,
                  expectedOrigin,
                  HTMLInputElement: CodeInput,
                  input,
                  InputEvent: FakeEvent,
                  self: { origin: frameOrigin },
                }
              )
            ),
          },
        };
        break;
      }
    }
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ id: command.id, result }),
        })
      )
    );
  }
}

function control(
  overrides: Partial<NativeLoginControlDescriptor>
): NativeLoginControlDescriptor {
  return {
    autocomplete: "",
    focused: false,
    formIndex: 0,
    index: 0,
    label: "",
    name: "",
    type: "text",
    ...overrides,
  };
}

const fill = (refocus?: boolean) =>
  fillKernelOneTimeCode({
    browserSessionId: "browser-1",
    code: "287082",
    expectedOrigin: "https://login.vendor.example",
    refocus,
  });

// One-character boxes, the first focused, as a split code field renders.
function codeBoxes(count: number, focusFirst = true) {
  inputs = Array.from({ length: count }, () => new CodeInput());
  controls = inputs.map((_input, index) =>
    control({
      autocomplete: index === 0 ? "one-time-code" : "",
      focused: focusFirst && index === 0,
      index,
      maxLength: 1,
      name: `otp-${String(index + 1)}`,
    })
  );
}

const probe = () =>
  assertKernelOneTimeCodeFocus({
    browserSessionId: "browser-1",
    expectedOrigin: "https://login.vendor.example",
  });

function filledFunctions() {
  return commands.filter(({ method }) => method === "Runtime.callFunctionOn");
}

beforeEach(() => {
  commands.length = 0;
  pageOrigin = "https://login.vendor.example";
  frameOrigin = pageOrigin;
  inputs = [new CodeInput(), new CodeInput()];
  controls = [
    control({ index: 0, name: "password", type: "password" }),
    control({ autocomplete: "one-time-code", focused: true, index: 1 }),
  ];
  vi.stubGlobal("WebSocket", BrowserSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("native one-time code injection", () => {
  it("fills the focused code field and marks it as a vault value", async () => {
    await expect(fill()).resolves.toBeUndefined();
    expect(inputs[1]?.value).toBe("287082");
    expect(inputs[1]?.dataset.vaultSecret).toBe("true");
    expect(inputs[0]?.value).toBe("");
  });

  it("refuses a focused field that does not ask for a code", async () => {
    controls = [
      control({ focused: true, index: 0, name: "password", type: "password" }),
      control({ autocomplete: "one-time-code", index: 1 }),
    ];
    await expect(fill()).rejects.toThrow(
      "Focus the visible authenticator code field of the sign-in and retry."
    );
    expect(filledFunctions()).toEqual([]);
  });

  it("refuses when no field is focused", async () => {
    controls = [control({ autocomplete: "one-time-code", index: 1 })];
    await expect(fill()).rejects.toThrow(
      "Focus the visible authenticator code field"
    );
    expect(filledFunctions()).toEqual([]);
  });

  it("writes nothing into a tab or frame served from another origin", async () => {
    pageOrigin = "https://evil.example";
    await expect(fill()).rejects.toThrow(
      "The active tab no longer matches the approved origin."
    );

    pageOrigin = "https://login.vendor.example";
    frameOrigin = "https://widget.other.example";
    await expect(fill()).rejects.toThrow(
      "Focus the visible authenticator code field"
    );
    expect(filledFunctions()).toEqual([]);
    expect(inputs.map(({ value }) => value)).toEqual(["", ""]);
  });

  it("checks the focused code field without writing into it", async () => {
    await expect(probe()).resolves.toBeUndefined();
    expect(filledFunctions()).toEqual([]);
    expect(inputs.map(({ value }) => value)).toEqual(["", ""]);
  });

  it("refuses what the fill refuses: another field, or another origin", async () => {
    controls = [
      control({ focused: true, index: 0, name: "password", type: "password" }),
    ];
    await expect(probe()).rejects.toThrow(
      "Focus the visible authenticator code field of the sign-in and retry."
    );

    controls = [
      control({ autocomplete: "one-time-code", focused: true, index: 1 }),
    ];
    pageOrigin = "https://evil.example";
    await expect(probe()).rejects.toThrow(
      "The active tab no longer matches the approved origin."
    );
    expect(filledFunctions()).toEqual([]);
  });

  it("fills a code split into one box per character, one character per box", async () => {
    codeBoxes(6);

    await expect(fill()).resolves.toBeUndefined();

    expect(inputs.map(({ value }) => value)).toEqual("287082".split(""));
    expect(inputs.every(({ dataset }) => dataset.vaultSecret === "true")).toBe(
      true
    );
  });

  it("fills split boxes from a code typed with a space or hyphen", async () => {
    codeBoxes(6);

    await expect(
      fillKernelOneTimeCode({
        browserSessionId: "browser-1",
        code: "287-082",
        expectedOrigin: "https://login.vendor.example",
      })
    ).resolves.toBeUndefined();

    expect(inputs.map(({ value }) => value)).toEqual("287082".split(""));
  });

  it("refuses a split field whose boxes do not match the code", async () => {
    codeBoxes(4);

    await expect(fill()).rejects.toThrow(
      "The code field has a different number of boxes than the code has characters."
    );
    expect(filledFunctions()).toEqual([]);
  });

  it("does not report a code filled when the field kept only part of it", async () => {
    inputs = [new CodeInput(), new CodeInput((next) => next.slice(0, 1))];

    await expect(fill()).rejects.toThrow(
      "The code field did not keep the code that was filled."
    );
  });

  it("accepts a field that shows the code spaced", async () => {
    inputs = [
      new CodeInput(),
      new CodeInput((next) => `${next.slice(0, 3)} ${next.slice(3)}`),
    ];

    await expect(fill()).resolves.toBeUndefined();
  });

  it("fills the page's only code field after focus moved, when asked to", async () => {
    controls = [
      control({ focused: true, index: 0, name: "password", type: "password" }),
      control({ autocomplete: "one-time-code", index: 1 }),
    ];

    await expect(fill()).rejects.toThrow(
      "Focus the visible authenticator code field"
    );
    await expect(fill(true)).resolves.toBeUndefined();
    expect(inputs.map(({ value }) => value)).toEqual(["", "287082"]);
  });

  it("refocuses the first box of the page's only split code field", async () => {
    codeBoxes(6, false);

    await expect(fill(true)).resolves.toBeUndefined();
    expect(inputs.map(({ value }) => value)).toEqual("287082".split(""));
  });

  it("never guesses between two code fields after focus moved", async () => {
    controls = [
      control({ autocomplete: "one-time-code", index: 0 }),
      control({ autocomplete: "one-time-code", index: 1 }),
    ];

    await expect(fill(true)).rejects.toThrow(
      "Focus the visible authenticator code field"
    );
    expect(filledFunctions()).toEqual([]);
  });
});
