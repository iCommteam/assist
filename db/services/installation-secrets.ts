import { assertProductionEnvironment, env } from "@shared/environment";

// The configured pair is the only source: there is no Blob store to provision
// secrets in, and local development gets fixed defaults from env.ts. Every
// production process passes the boot guard before it gets a secret.
export async function getInstallationSecrets() {
  assertProductionEnvironment();
  const betterAuthSecret = env.BETTER_AUTH_SECRET;
  const secretEncryptionKey = env.SECRET_ENCRYPTION_KEY;
  if (!betterAuthSecret || !secretEncryptionKey) {
    throw new Error(
      "Installation secrets are unavailable. Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY."
    );
  }
  return { betterAuthSecret, secretEncryptionKey };
}
