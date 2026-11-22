import { env } from "@shared/environment";

// The configured pair is the only source: there is no Blob store to provision
// secrets in, and local development gets fixed defaults from env.ts.
export async function getInstallationSecrets() {
  const betterAuthSecret = env.BETTER_AUTH_SECRET;
  const secretEncryptionKey = env.SECRET_ENCRYPTION_KEY;
  if (!betterAuthSecret || !secretEncryptionKey) {
    throw new Error(
      "Installation secrets are unavailable. Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY."
    );
  }
  return { betterAuthSecret, secretEncryptionKey };
}
