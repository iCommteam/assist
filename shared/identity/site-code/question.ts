// Marks the one question a site task may ask: the browser worker's request
// for a one-time code. The site API, the hook that stops a site task at any
// other request and the browser trace tell it apart by this title, which a
// model cannot set. No Node.js imports: the worker's workflow body reads it.
export const siteCodeQuestionTitle = "One-time code";

export function isSiteCodeQuestion(request: {
  readonly kind: string;
  readonly title?: string;
}) {
  return request.kind === "question" && request.title === siteCodeQuestionTitle;
}
