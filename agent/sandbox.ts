import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// Railway has no Docker daemon, and a production build would otherwise record no
// sandbox, which turns every screenshot and attachment into a "could not be
// stored" note. just-bash runs no native processes and every shell tool is
// disabled for both agents, so it only stores files.
export const environment = JustBashSandbox.environment({ autoInstall: false });
export default defineSandbox(() => environment.open());
