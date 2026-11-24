import { defineDynamic, defineInstructions } from "eve/instructions";
import {
  siteLoginOfSession,
  siteTaskKindOfSession,
} from "@agent/lib/site-principal";
import fetchDocuments from "./content/site-documents/fetch.md?raw";
import lookDocuments from "./content/site-documents/look.md?raw";
import siteLogin from "./content/site-login.md?raw";

// A worker inherits the root session's initiator, so this follows the pin of
// the site task that delegated it, and whether that task is a look.
export default defineDynamic((context) => {
  const { initiator } = context.session.auth;
  const login = siteLoginOfSession(initiator);
  const documents =
    siteTaskKindOfSession(initiator) === "look"
      ? lookDocuments
      : fetchDocuments;
  return login
    ? defineInstructions({
        content: siteLogin
          .replace("{{documents}}", documents.trimEnd())
          .replaceAll("{{origin}}", login.origin)
          .replaceAll(
            "{{alsoHosts}}",
            login.alsoHosts.map((host) => `\`${host}\``).join(", ") || "none"
          ),
      })
    : null;
});
