import { defineDynamic, defineInstructions } from "eve/instructions";
import {
  siteKindOfSession,
  siteLoginOfSession,
  siteOfSession,
  siteTaskKindOfSession,
  siteTaskNoteOfSession,
} from "@agent/lib/site-principal";
import loginFetch from "./content/site-documents/login-fetch.md?raw";
import loginLook from "./content/site-documents/login-look.md?raw";
import taskFetch from "./content/site-documents/task-fetch.md?raw";
import taskLook from "./content/site-documents/task-look.md?raw";
import siteLogin from "./content/site-login.md?raw";
import siteTask from "./content/site-task.md?raw";

// A fetch brings files back with the worker's save_file; a look lists what
// the account holds and has no save_file.
const documentsOf = {
  fetch: { login: loginFetch, task: taskFetch },
  look: { login: loginLook, task: taskLook },
} as const;

// The one line the owner's note becomes, which the coordinator copies word
// for word into the worker's assignment.
const noteLead = "Where to look, as the owner noted for this account: ";

export default defineDynamic((context) => {
  const { initiator } = context.session.auth;
  // A site chat has its own role instead.
  if (siteKindOfSession(initiator) !== "task") return null;
  const site = siteOfSession(initiator);
  if (!site) return null;
  const documents = documentsOf[siteTaskKindOfSession(initiator) ?? "fetch"];
  const login = siteLoginOfSession(initiator);
  const task = siteTask
    .replaceAll("{{site}}", site)
    .replace("{{documents}}", documents.task.trimEnd());
  if (!login) return defineInstructions({ content: task });
  const pinned = siteLogin
    .replace("{{documents}}", documents.login.trimEnd())
    .replaceAll("{{origin}}", login.origin)
    .replaceAll(
      "{{alsoHosts}}",
      login.alsoHosts.map((host) => `\`${host}\``).join(", ") || "none"
    );
  // Added after every substitution, so the note's text stays as it was
  // saved.
  const note = siteTaskNoteOfSession(initiator);
  return defineInstructions({
    content: `${task}\n${pinned}${note === undefined ? "" : `\n${noteLead}${note}\n`}`,
  });
});
