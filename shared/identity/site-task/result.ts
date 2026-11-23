import { z } from "zod";

// The root agent ends a site task by calling this tool with one result. The
// site API reads the last result of the site's own turn, never the reply, to
// tell a site why its task failed.
export const siteTaskEndToolName = "end_site_task";

export const siteTaskResultSchema = z.enum([
  "done",
  "nothing_found",
  "login_failed",
  "code_failed",
  "blocked",
  "off_site",
  "failed",
]);
