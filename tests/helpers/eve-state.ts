// An in-memory stand-in for eve's per-session `defineState`, for tools and
// hooks tested outside an eve context:
//   vi.mock("eve/context", () => import("@tests/helpers/eve-state"));
// Call resetEveState() between tests to start every slot from its initial value.
const resets = new Set<() => void>();

export function defineState<T>(_name: string, initial: () => T) {
  let value = initial();
  resets.add(() => {
    value = initial();
  });
  return {
    get: () => value,
    update: (update: (current: T) => T) => {
      value = update(value);
    },
  };
}

export function resetEveState() {
  for (const reset of resets) reset();
}
