/**
 * OAuth client setup.
 *
 * The @atproto/oauth-client-browser library handles all token persistence
 * in its own IndexedDB (sessions, state, DPoP keys). We just configure
 * the client, run it on app boot, and expose the resulting OAuthSession.
 *
 * Dev: uses loopback client ID derived from window.location.
 * Prod: requires a published client-metadata.json at the app's eTLD+1.
 */
import { BrowserOAuthClient, buildLoopbackClientId } from "@atproto/oauth-client-browser";
import type { OAuthSession } from "@atproto/oauth-client-browser";

let clientPromise: Promise<BrowserOAuthClient> | null = null;

/**
 * Per RFC 8252 the loopback redirect URI must use `127.0.0.1`, not
 * `localhost`. The OAuth client validates this and rejects metadata
 * built from a localhost origin. If the dev server was hit via
 * `localhost`, redirect once to the equivalent `127.0.0.1` URL so the
 * page itself ends up on the same origin the OAuth callback returns to.
 *
 * Returns `true` if a redirect was initiated (caller should bail out).
 */
function ensureLoopbackIp(): boolean {
  if (window.location.hostname !== "localhost") return false;
  const url = new URL(window.location.href);
  url.hostname = "127.0.0.1";
  window.location.replace(url.toString());
  return true;
}

/**
 * Production OAuth client ID — points at the published client-metadata.json
 * served from the app's eTLD+1. Override at build time with
 * VITE_OAUTH_CLIENT_ID for staging/preview deploys.
 */
const PROD_CLIENT_ID: string =
  (import.meta.env["VITE_OAUTH_CLIENT_ID"] as string | undefined) ??
  "https://decay.cards/client-metadata.json";

function getClient(): Promise<BrowserOAuthClient> {
  if (clientPromise) return clientPromise;

  const isLoopback =
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "[::1]";

  if (isLoopback) {
    // Loopback dev: `buildLoopbackClientId` encodes the 127.0.0.1 redirect
    // URI as a query param on the client_id and doesn't need a published
    // metadata document.
    const clientId = buildLoopbackClientId(window.location);
    clientPromise = BrowserOAuthClient.load({
      clientId,
      handleResolver: "https://bsky.social",
    });
    return clientPromise;
  }

  // Production: load metadata from the published JSON document at PROD_CLIENT_ID.
  clientPromise = BrowserOAuthClient.load({
    clientId: PROD_CLIENT_ID,
    handleResolver: "https://bsky.social",
  });
  return clientPromise;
}

/**
 * Run on app boot. Restores any existing session and processes the OAuth
 * callback if the URL contains code/state params. Cleans the URL afterward
 * so a refresh doesn't re-trigger the callback.
 */
export async function initAuth(): Promise<OAuthSession | null> {
  if (ensureLoopbackIp()) {
    // Browser is navigating to the 127.0.0.1 equivalent; return a
    // never-resolving promise so the rest of boot doesn't run.
    return new Promise(() => {});
  }
  const client = await getClient();
  const result = await client.init();
  if (!result) return null;

  // If a callback was processed, clear oauth params from the URL.
  if ("state" in result) {
    const url = new URL(window.location.href);
    if (url.searchParams.has("code") || url.searchParams.has("state")) {
      url.searchParams.delete("code");
      url.searchParams.delete("state");
      url.searchParams.delete("iss");
      window.history.replaceState(null, "", url.pathname + url.search);
    }
  }
  return result.session;
}

/**
 * Begin sign-in. Redirects the browser to the user's PDS authorization
 * server. Resolves only if redirect fails — the success path leaves the page.
 */
export async function signIn(handleOrDid: string): Promise<void> {
  const client = await getClient();
  await client.signInRedirect(handleOrDid);
}

export async function signOut(session: OAuthSession): Promise<void> {
  await session.signOut();
}

export type { OAuthSession };
