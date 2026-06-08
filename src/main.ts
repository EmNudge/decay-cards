import { createApp } from "vue";
import App from "./App.vue";
import "./index.css";
import { initTheme } from "./composables/useTheme";
import { initAtproto } from "./atproto/client";

initTheme();
// Restore session / process OAuth callback before mounting so the app sees
// signed-in state on the first render. Errors are non-fatal — the user can
// retry sign-in from the UI.
initAtproto()
  .catch((err) => console.error("[atproto] init failed:", err))
  .finally(() => createApp(App).mount("#app"));
