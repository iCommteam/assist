// Tabs a worker tool opens in the worker's browser for its own use, such as
// save_file's download tab. Such a tab is never the worker's page, so a tool
// that acts on the worker's page passes over it. Only pinned site tasks open
// one, so for every other session the set stays empty.
const toolTabs = new Set<string>();

// Returns the function that forgets the tab once it is closed.
export function trackToolTab(targetId: string) {
  toolTabs.add(targetId);
  return () => {
    toolTabs.delete(targetId);
  };
}

export function isToolTab(targetId: string) {
  return toolTabs.has(targetId);
}
