/**
 * Phase 2 card renderer — drives the cross-origin iframe shell.
 *
 * The shell at `decaycards.emnudge.dev` (config: VITE_RENDER_SHELL_URL)
 * receives card HTML + media as ArrayBuffers via postMessage and renders
 * in its own origin so the host app's cookies/storage can never leak to
 * card-author HTML.
 *
 * If the shell URL isn't configured, callers should use the Phase 1
 * srcdoc fallback (`useCardRenderer.buildSrcdoc`). `isShellConfigured()`
 * lets callers branch.
 */

interface MediaPayload {
  filename: string;
  data: ArrayBuffer;
  mimeType?: string;
}

interface RenderMessage {
  type: "render";
  html: string;
  media: MediaPayload[];
}

const SHELL_URL: string | undefined =
  (import.meta.env["VITE_RENDER_SHELL_URL"] as string | undefined) ?? undefined;

export function isShellConfigured(): boolean {
  return typeof SHELL_URL === "string" && SHELL_URL.length > 0;
}

export function getShellUrl(): string | undefined {
  return SHELL_URL;
}

export function getShellOrigin(): string | undefined {
  if (!SHELL_URL) return undefined;
  try {
    return new URL(SHELL_URL).origin;
  } catch {
    return undefined;
  }
}

/**
 * Send a render message to an iframe pointing at the shell. Waits for the
 * shell to post `{type: "ready"}` first so we don't race the load.
 * Throws if the shell origin isn't configured.
 */
export async function renderIntoShell(
  iframe: HTMLIFrameElement,
  html: string,
  media: MediaPayload[],
): Promise<void> {
  const shellOrigin = getShellOrigin();
  if (!shellOrigin) {
    throw new Error("Render shell origin not configured (VITE_RENDER_SHELL_URL)");
  }
  await waitForReady(iframe, shellOrigin);
  const msg: RenderMessage = { type: "render", html, media };
  iframe.contentWindow?.postMessage(msg, shellOrigin, transferables(media));
}

export function broadcastThemeToShell(iframe: HTMLIFrameElement, theme: "light" | "dark"): void {
  const shellOrigin = getShellOrigin();
  if (!shellOrigin) return;
  iframe.contentWindow?.postMessage({ type: "theme", theme }, shellOrigin);
}

function transferables(media: MediaPayload[]): Transferable[] {
  return media.map((m) => m.data);
}

/**
 * Wait for the iframe to signal readiness. If the iframe has already
 * loaded and we missed the initial `ready`, we send a no-op nudge and
 * accept the first response — the shell re-posts ready on any unknown
 * message it can't handle (the contract). To keep things simple here we
 * just resolve after either `ready` or load.
 */
function waitForReady(iframe: HTMLIFrameElement, expectedOrigin: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", onLoad);
      resolve();
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== expectedOrigin) return;
      const data = ev.data as { type?: string } | null;
      if (data?.type === "ready") finish();
    };
    const onLoad = () => {
      // Give the shell a tick to install its message listener.
      setTimeout(finish, 16);
    };
    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", onLoad);
    // If the iframe is already loaded, schedule a fallback resolve.
    if (iframe.contentDocument?.readyState === "complete") {
      setTimeout(finish, 16);
    }
  });
}
