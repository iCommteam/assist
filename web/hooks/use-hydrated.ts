import { useSyncExternalStore } from "react";

// False in the server's markup and while the page hydrates, true after. A
// form submitted before React handles it is a native GET, which puts its
// fields, a password among them, in the address; its submit button waits
// for this.
export function useHydrated() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe() {
  return () => undefined;
}

function getSnapshot() {
  return true;
}

function getServerSnapshot() {
  return false;
}
