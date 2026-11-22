import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// The browser worker's own sandbox, for the same reason as agent/sandbox.ts: it
// stores the screenshots computer_action returns, so they reach the model.
export const environment = JustBashSandbox.environment({ autoInstall: false });
export default defineSandbox(() => environment.open());
