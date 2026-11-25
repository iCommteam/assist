import { z } from "zod";

// A POST from the Connectors section to one of its routes
// (app/api/connectors/google). The proxy answers a member whose session ended
// with a redirect to the sign-in page, which fetch does not follow here, and
// a route answers 401: both read as signed out, so the page can send the
// member to sign in instead of asking them to try again.
export async function postToConnector(path: string) {
  const response = await fetch(path, { method: "POST", redirect: "manual" });
  if (response.type === "opaqueredirect" || response.status === 401) {
    return { signedOut: true } as const;
  }
  return {
    body: await readJson(response),
    signedOut: false,
    status: response.status,
  } as const;
}

async function readJson(response: Response) {
  try {
    return z.json().parse(await response.json());
  } catch {
    return null;
  }
}
