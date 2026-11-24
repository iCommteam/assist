import { defineDynamic, defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import { siteKindOfSession } from "@agent/lib/site-principal";
import {
  siteTaskEndToolName,
  siteTaskResultSchema,
} from "@shared/identity/site-task/result";

// Only a site task ends through a result a server reads; a site chat has no
// end. Whether a site finds files comes from the files the task saved, never
// from this result.
const endSiteTask = defineTool({
  availableInSubagents: false,
  description:
    "End this site task with the one result that fits, after its send_message reply. done: the work the task asked for is finished. nothing_found: the work was possible but what the task asked for does not exist. login_failed: the website refused the saved username or password. sign_in_elsewhere: the website asks for the password on a different page of the same site than the saved one. code_failed: a one-time or authenticator code was refused, expired, could not be filled, or did not arrive in time. blocked: the website wants something only a person can do, such as a CAPTCHA, bot check, device or push approval, passkey or new-device email link, or the task needs a sign-in it has no saved login for. off_site: what the task needs is on a website the browser may not open. failed: the task could not finish for any other reason.",
  endsTurn: true,
  inputSchema: z.object({ result: siteTaskResultSchema }),
  execute: ({ result }) => ({ result }),
  toModelOutput() {
    return toolOutput.text("The task result was recorded.");
  },
});

export default defineDynamic((context) =>
  siteKindOfSession(context.session.auth.initiator) === "task"
    ? { [siteTaskEndToolName]: endSiteTask }
    : null
);
