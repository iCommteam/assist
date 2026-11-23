import type { Interaction } from "eve/events";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuestionRequest } from "./interaction";

const codeQuestion: Interaction = {
  interactionId: "interaction-1",
  request: {
    allowFreeform: true,
    kind: "question",
    prompt:
      'Enter the one-time code that login.vendor.example just sent by email for the saved login "Vendor".',
    title: "One-time code",
  },
  status: "open",
  stepIndex: 0,
  turnId: "turn_0",
};

function render(interaction: Interaction) {
  return renderToStaticMarkup(
    <QuestionRequest
      canRespond
      interaction={interaction}
      onAnswers={() => undefined}
    />
  );
}

describe("site code question in the chat", () => {
  it("shows the question with no way to answer it", () => {
    const markup = render(codeQuestion);

    expect(markup).toContain("just sent by email");
    expect(markup).toContain(
      "Only the site that started this task can answer this question."
    );
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain(">Answer<");
  });

  it("never shows the sealed answer the site sent", () => {
    const markup = render({
      ...codeQuestion,
      answer: { interactionId: "interaction-1", text: "assist-code.v1.sealed" },
      status: "settled",
    });

    expect(markup).toContain("The site that started this task sent the code.");
    expect(markup).not.toContain("assist-code");
  });

  it("keeps an ordinary question answerable", () => {
    const markup = render({
      ...codeQuestion,
      request: {
        allowFreeform: true,
        kind: "question",
        prompt: "Which store?",
      },
    });

    expect(markup).toContain(">Answer<");
  });
});
