import { initTRPC } from "@trpc/server";
import type { TRPCContext } from "./context";

// Errors reach the browser without stacks or procedure paths, and an
// unexpected server error says only that the request failed.
const t = initTRPC.context<TRPCContext>().create({
  errorFormatter(failure) {
    const { error } = failure;
    const response = failure.shape;
    return {
      ...response,
      data: { code: response.data.code, httpStatus: response.data.httpStatus },
      message:
        error.code === "INTERNAL_SERVER_ERROR"
          ? "The request failed."
          : response.message,
    };
  },
  isDev: false,
});

export const createTRPCRouter = t.router;
export const protectedProcedure = t.procedure;
