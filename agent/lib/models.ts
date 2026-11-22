import {
  wrapLanguageModel,
  type JSONSchema7,
  type LanguageModelMiddleware,
} from "ai";
import { anthropic } from "eve/models/anthropic";

// Both agents call Anthropic directly with ANTHROPIC_API_KEY. Off Vercel there is
// no AI Gateway catalog, so eve cannot look the context window up and it is set here
// (Models API: max_input_tokens 1,000,000 for claude-opus-5-5).
const modelId = "claude-opus-5-5";
export const MODEL_CONTEXT_WINDOW_TOKENS = 1_000_000;

// A definition is a schema object, or `true`/`false` for "any"/"nothing".
function schemaObjects(
  definitions: readonly (JSONSchema7 | boolean | undefined)[]
) {
  return definitions.filter(
    (definition) =>
      definition !== undefined && definition !== true && definition !== false
  );
}

// The Anthropic API wants every tool input schema to be one object, with no
// oneOf / anyOf / allOf at the top level; send_message and request_vault_setup take
// a union (the AI Gateway accepted that). The union becomes one object holding every
// variant's fields, required only where every variant requires them, and a field
// that differs between variants becomes an anyOf one level down. eve still
// validates every tool input against the tool's own schema, so a mixed shape is
// refused there.
export function toObjectInputSchema(schema: JSONSchema7): JSONSchema7 {
  const variants = schema.oneOf ?? schema.anyOf ?? schema.allOf;
  if (!variants) {
    return schema.type === undefined ? { ...schema, type: "object" } : schema;
  }
  const objects = schemaObjects(variants).map(toObjectInputSchema);
  const keys = [
    ...new Set(
      objects.flatMap((variant) => Object.keys(variant.properties ?? {}))
    ),
  ];
  const properties: Record<string, JSONSchema7> = {};
  for (const key of keys) {
    const options = schemaObjects(
      objects.map((variant) => variant.properties?.[key])
    );
    const unique = [
      ...new Map(
        options.map((option) => [JSON.stringify(option), option])
      ).values(),
    ];
    const [first, ...others] = unique;
    if (first === undefined) continue;
    properties[key] = others.length === 0 ? first : { anyOf: unique };
  }
  const requiredLists = objects.map((variant) => variant.required ?? []);
  const required =
    schema.allOf === undefined
      ? keys.filter((key) => requiredLists.every((list) => list.includes(key)))
      : [...new Set(requiredLists.flat())];
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema;
  const merged: JSONSchema7 = { ...rest, type: "object", properties };
  if (required.length > 0) merged.required = required;
  if (objects.every((variant) => variant.additionalProperties === false)) {
    merged.additionalProperties = false;
  }
  return merged;
}

const objectToolSchemas: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    tools: params.tools?.map((tool) =>
      tool.type === "function"
        ? { ...tool, inputSchema: toObjectInputSchema(tool.inputSchema) }
        : tool
    ),
  }),
};

export function anthropicModel() {
  return wrapLanguageModel({
    model: anthropic(modelId),
    middleware: objectToolSchemas,
  });
}

export function coordinatorModel() {
  return {
    model: anthropicModel(),
    modelContextWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS,
  };
}
