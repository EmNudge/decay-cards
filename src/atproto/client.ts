/**
 * Authenticated AT Proto agent + reactive sign-in state.
 *
 * The agent is null until `initAtproto()` is called (typically once on app
 * boot). After sign-in or restore, the agent points at the user's PDS via
 * the OAuthSession's DPoP-bound fetch handler.
 */
import { shallowRef, computed } from "vue";
import { Agent } from "@atproto/api";
import { initAuth, signIn, signOut, type OAuthSession } from "./auth";
import { startSyncScheduler, stopSyncScheduler } from "./scheduler";

const session = shallowRef<OAuthSession | null>(null);
const agent = shallowRef<Agent | null>(null);

export const isSignedIn = computed(() => agent.value !== null);
export const currentDid = computed(() => session.value?.did ?? null);

export function getAgent(): Agent | null {
  return agent.value;
}

export function requireAgent(): Agent {
  if (!agent.value) throw new Error("Not signed in");
  return agent.value;
}

let initPromise: Promise<void> | null = null;

/**
 * Restore any existing session on app boot. Idempotent.
 */
export function initAtproto(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const restored = await initAuth();
    if (restored) {
      session.value = restored;
      const newAgent = new Agent(restored);
      agent.value = newAgent;
      startSyncScheduler(newAgent);
    }
  })();
  return initPromise;
}

/**
 * Begin OAuth sign-in. Redirects the browser; does not resolve on success.
 */
export async function startSignIn(handleOrDid: string): Promise<void> {
  await signIn(handleOrDid);
}

export async function endSignOut(): Promise<void> {
  stopSyncScheduler();
  if (session.value) {
    await signOut(session.value);
  }
  session.value = null;
  agent.value = null;
}
