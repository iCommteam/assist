import { z } from "zod";

// A site request's JSON body, or undefined when it is too large or not JSON.
export async function readSiteJsonBody(request: Request, maxBytes: number) {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    return undefined;
  }
  const text = await request.text();
  if (text.length > maxBytes) return undefined;
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}
