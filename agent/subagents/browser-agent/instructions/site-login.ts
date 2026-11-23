import { defineDynamic, defineInstructions } from "eve/instructions";
import { siteLoginOfSession } from "@agent/lib/site-principal";
import siteLogin from "./content/site-login.md?raw";

// A worker inherits the root session's initiator, so this follows the pin of
// the site task that delegated it.
export default defineDynamic((context) => {
  const login = siteLoginOfSession(context.session.auth.initiator);
  return login
    ? defineInstructions({
        content: siteLogin.replaceAll("{{origin}}", login.origin),
      })
    : null;
});
