import { defineDynamic, defineInstructions } from "eve/instructions";
import { siteOfSession } from "@agent/lib/site-principal";
import siteTask from "./content/site-task.md?raw";

export default defineDynamic((context) => {
  const site = siteOfSession(context.session.auth.initiator);
  return site
    ? defineInstructions({ content: siteTask.replaceAll("{{site}}", site) })
    : null;
});
