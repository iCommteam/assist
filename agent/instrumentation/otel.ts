import { otel } from "eve/instrumentation/otel";

export default otel({
  traceChannelRequests: true,
  // Safe only with the explicit run-data retention in both agents' agent.ts:
  // otherwise eve derives zero retention from this policy and deletes finished
  // session transcripts.
  tracePolicy: () => ({
    emit: true,
    recordInputs: false,
    recordOutputs: false,
  }),
});
