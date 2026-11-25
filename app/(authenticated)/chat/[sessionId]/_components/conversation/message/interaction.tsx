import {
  APPROVE_OPTION_ID,
  DENY_OPTION_ID,
  type Interaction,
  type InteractionOption,
} from "eve/events";
import {
  Question,
  QuestionActions,
  QuestionDescription,
  QuestionInput,
  QuestionOption,
  QuestionOptions,
  QuestionPrompt,
  type QuestionResponse,
  QuestionSubmit,
} from "@web/components/ai-elements/question";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import { isSiteCodeQuestion } from "@shared/identity/site-code/question";
import type { RespondToAgentInput } from "./types";

export function QuestionRequest({
  canRespond,
  interaction,
  onAnswers,
}: {
  readonly canRespond: boolean;
  readonly interaction: Interaction;
  readonly onAnswers: RespondToAgentInput;
}) {
  const { answer, interactionId, request } = interaction;
  if (isSiteCodeQuestion(request)) {
    return <SiteCodeQuestion interaction={interaction} />;
  }
  const options = request.options ?? [];
  const selectedOption = options.find(
    (option) => option.id === answer?.optionId
  );
  const hasOptions = options.length > 0;
  const acceptsFreeform = request.allowFreeform === true || !hasOptions;

  const submitResponse = ({ selectedValues, text }: QuestionResponse) =>
    onAnswers([{ interactionId, optionId: selectedValues[0], text }]);

  return (
    <Question
      defaultValue={{
        selectedValues: answer?.optionId ? [answer.optionId] : [],
        text: answer?.text ?? "",
      }}
      disabled={
        !canRespond || interaction.status === "settled" || answer !== undefined
      }
      onSubmit={submitResponse}
    >
      <QuestionPrompt>{request.prompt}</QuestionPrompt>
      {hasOptions ? (
        <QuestionOptions
          className="flex-col items-stretch"
          aria-label={request.prompt}
        >
          {options.map((option) => (
            <QuestionOption
              className="justify-start text-left"
              key={option.id}
              value={option.id}
            >
              <span>
                <span className="block">{option.label}</span>
                {option.description ? (
                  <span className="block type-caption opacity-70">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </QuestionOption>
          ))}
        </QuestionOptions>
      ) : null}
      {acceptsFreeform ? (
        <QuestionInput aria-label="Answer" placeholder="Type your answer…" />
      ) : null}
      {answer ? (
        <QuestionDescription>
          Responded: {selectedOption?.label ?? answer.text ?? answer.optionId}
        </QuestionDescription>
      ) : interaction.status === "settled" ? (
        <QuestionDescription>No longer needs an answer.</QuestionDescription>
      ) : (
        <QuestionActions>
          <QuestionSubmit>Answer</QuestionSubmit>
        </QuestionActions>
      )}
    </Question>
  );
}

// A site task's one-time code question. Only the site that started the task
// can answer it: the site API seals the code before eve sees it, and a code
// typed here would reach the task in plain text and end it.
function SiteCodeQuestion({
  interaction,
}: {
  readonly interaction: Interaction;
}) {
  return (
    <Question disabled>
      <QuestionPrompt>{interaction.request.prompt}</QuestionPrompt>
      <QuestionDescription>
        {interaction.answer
          ? "The site that started this task sent the code."
          : interaction.status === "settled"
            ? "No longer needs an answer."
            : "Only the site that started this task can answer this question."}
      </QuestionDescription>
    </Question>
  );
}

/** Approve and deny choices, or the options an approval or budget prompt lists. */
export function InteractionActions({
  canRespond,
  interaction,
  onAnswers,
}: {
  readonly canRespond: boolean;
  readonly interaction: Interaction;
  readonly onAnswers: RespondToAgentInput;
}) {
  const { answer, interactionId, request } = interaction;
  const options = request.options ?? defaultApprovalOptions;
  const selectedOption = options.find(
    (option) => option.id === answer?.optionId
  );

  return (
    <Alert variant="warning">
      {/* An approval can show a whole email or event, line by line. */}
      <AlertTitle className="wrap-break-word whitespace-pre-line">
        {request.prompt}
      </AlertTitle>
      <AlertDescription>
        {answer ? (
          <p>
            Responded: {selectedOption?.label ?? answer.text ?? answer.optionId}
          </p>
        ) : interaction.status === "settled" ? (
          <p>No longer needs a response.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                disabled={!canRespond}
                key={option.id}
                onClick={() => {
                  void onAnswers([{ interactionId, optionId: option.id }]);
                }}
                size="sm"
                type="button"
                variant={option.style === "danger" ? "destructive" : "default"}
              >
                {option.label}
              </Button>
            ))}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

const defaultApprovalOptions: readonly InteractionOption[] = [
  { id: APPROVE_OPTION_ID, label: "Approve", style: "primary" },
  { id: DENY_OPTION_ID, label: "Deny", style: "danger" },
];
