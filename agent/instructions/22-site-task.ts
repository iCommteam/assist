import { defineDynamic, defineInstructions } from "eve/instructions";
import { siteLoginOfSession, siteOfSession } from "@agent/lib/site-principal";
import siteLogin from "./content/site-login.md?raw";
import siteTask from "./content/site-task.md?raw";

export default defineDynamic((context) => {
  const { initiator } = context.session.auth;
  const site = siteOfSession(initiator);
  if (!site) return null;
  const login = siteLoginOfSession(initiator);
  const task = siteTask.replaceAll("{{site}}", site);
  return defineInstructions({
    content: login
      ? `${task}\n${siteLogin
          .replaceAll("{{origin}}", login.origin)
          .replaceAll(
            "{{alsoHosts}}",
            login.alsoHosts.map((host) => `\`${host}\``).join(", ") || "none"
          )}`
      : task,
  });
});
