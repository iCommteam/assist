import type { AccessScope } from "@shared/identity/access-scope";

// The service runs one replica, so memory can serialize requests: a run for a
// key starts only once the run before it for that key has settled.
export async function oneAtATime<T>(
  queue: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>
) {
  const previous = queue.get(key);
  const current = (previous ?? Promise.resolve()).then(run, run);
  queue.set(key, current);
  try {
    return await current;
  } finally {
    if (queue.get(key) === current) queue.delete(key);
  }
}

const loginsInUse = new Map<string, Promise<Response>>();

// Starting a task pinned to a login and removing that login read the login's
// open task first, so they run one at a time per login: two starts cannot both
// find it free, and a removal cannot slip in while a start is under way.
export async function oneUseOfLoginAtATime(
  scope: AccessScope,
  site: string,
  loginId: string,
  run: () => Promise<Response>
) {
  return oneAtATime(
    loginsInUse,
    `${scope.workspaceId}\0${site}\0${loginId}`,
    run
  );
}
