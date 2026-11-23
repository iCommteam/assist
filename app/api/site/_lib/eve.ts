import { Client } from "eve/client";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { env } from "@shared/environment";
import {
  mintSiteCredential,
  type SiteGrant,
} from "@shared/identity/site-credential";

// The eve server that `withEve` starts beside Next. Site calls go to it over
// loopback with a fresh short-lived credential on every request, retries
// included, so the site's own token never reaches eve.
export function siteEveClient(grant: SiteGrant) {
  return new Client({
    auth: {
      async bearer() {
        const { betterAuthSecret } = await getInstallationSecrets();
        return mintSiteCredential(betterAuthSecret, grant);
      },
    },
    baseUrl: `http://127.0.0.1:${String(env.EVE_NEXT_PRODUCTION_PORT ?? 4274)}`,
  });
}
