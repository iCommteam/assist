import { describe, expect, it } from "vitest";
import { toObjectInputSchema } from "@agent/lib/models";

describe("Anthropic tool input schemas", () => {
  it("keeps an object schema and types an untyped one as an object", () => {
    const object = {
      type: "object" as const,
      properties: { query: { type: "string" as const } },
      required: ["query"],
    };
    expect(toObjectInputSchema(object)).toBe(object);
    expect(toObjectInputSchema({ properties: {} })).toEqual({
      properties: {},
      type: "object",
    });
  });

  it("merges a top-level union into one object", () => {
    expect(
      toObjectInputSchema({
        description: "Send a message or a reaction.",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "text" },
              target: { type: "string" },
              text: { type: "string" },
            },
            required: ["kind", "target", "text"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              emoji: { type: "string" },
              kind: { const: "reaction" },
              target: { type: "string" },
            },
            required: ["emoji", "kind", "target"],
            additionalProperties: false,
          },
          true,
        ],
      })
    ).toEqual({
      additionalProperties: false,
      description: "Send a message or a reaction.",
      properties: {
        emoji: { type: "string" },
        kind: { anyOf: [{ const: "text" }, { const: "reaction" }] },
        target: { type: "string" },
        text: { type: "string" },
      },
      required: ["kind", "target"],
      type: "object",
    });
  });

  it("requires every field an intersection requires", () => {
    expect(
      toObjectInputSchema({
        allOf: [
          {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        ],
      })
    ).toEqual({
      properties: { id: { type: "string" }, label: { type: "string" } },
      required: ["id", "label"],
      type: "object",
    });
  });
});
