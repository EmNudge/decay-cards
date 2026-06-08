<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  startSignIn,
  endSignOut,
  currentDid,
  isSignedIn,
  getAgent,
} from "../atproto/client";
import { runSync, syncStatus } from "../atproto/scheduler";
import { deadLettersDb } from "../db/deadLetters";
import type { DeadLetterEntry } from "../db/schema";

defineEmits<{ close: [] }>();

const handle = ref("");
const error = ref<string | null>(null);
const busy = ref(false);
const deadLetters = ref<DeadLetterEntry[]>([]);
const showDeadLetters = ref(false);

const lastSyncedLabel = computed(() => {
  const ts = syncStatus.lastSyncedAt.value;
  if (!ts) return "Never synced";
  const date = new Date(ts);
  return `Synced ${date.toLocaleTimeString()}`;
});

const migrationLabel = computed(() => {
  const p = syncStatus.migrationProgress.value;
  if (!p || p.done) return null;
  return `Migrating ${p.queued.toLocaleString()} / ${p.total.toLocaleString()}`;
});

async function refreshDeadLetters(): Promise<void> {
  deadLetters.value = await deadLettersDb.getAll();
}

onMounted(refreshDeadLetters);

async function onSignIn() {
  error.value = null;
  const input = handle.value.trim();
  if (!input) {
    error.value = "Enter a handle or DID";
    return;
  }
  busy.value = true;
  try {
    await startSignIn(input);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function onSignOut() {
  busy.value = true;
  try {
    await endSignOut();
  } finally {
    busy.value = false;
  }
}

async function onSyncNow() {
  const agent = getAgent();
  if (!agent) return;
  await runSync(agent);
  await refreshDeadLetters();
}

async function onClearDeadLetters() {
  if (!confirm("Discard all dead-lettered sync entries? They will not be retried.")) return;
  await deadLettersDb.clear();
  await refreshDeadLetters();
}
</script>

<template>
  <div class="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" @click.self="$emit('close')">
    <div class="bg-surface border border-line rounded-[var(--r-md)] shadow-xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-base font-semibold">AT Protocol Account</h2>
        <button class="btn-icon" aria-label="Close" @click="$emit('close')">×</button>
      </div>

      <div v-if="isSignedIn" class="space-y-4">
        <div class="text-sm">
          <div class="text-fg-muted">Signed in as</div>
          <div class="font-mono text-xs break-all">{{ currentDid }}</div>
        </div>

        <div class="border-t border-line pt-3 space-y-2">
          <div class="flex items-center justify-between text-sm">
            <div class="flex items-center gap-2">
              <span
                class="inline-block w-2 h-2 rounded-full"
                :style="{
                  background: syncStatus.syncing.value
                    ? 'var(--c-accent)'
                    : syncStatus.hasError.value
                      ? '#ef4444'
                      : '#22c55e',
                }"
              ></span>
              <span class="text-fg-muted">
                {{ syncStatus.syncing.value ? "Syncing…" : lastSyncedLabel }}
              </span>
            </div>
            <button
              class="text-xs px-2 py-1 rounded-[var(--r-sm)] hover:bg-elevated"
              :disabled="syncStatus.syncing.value || busy"
              @click="onSyncNow"
            >
              Sync now
            </button>
          </div>

          <p v-if="migrationLabel" class="text-xs text-fg-muted">
            {{ migrationLabel }}
          </p>

          <p v-if="syncStatus.lastError.value" class="text-xs text-amber-500">
            {{ syncStatus.lastError.value }}
          </p>

          <div v-if="deadLetters.length > 0" class="text-xs">
            <button
              class="text-red-500 underline-offset-2 hover:underline"
              @click="showDeadLetters = !showDeadLetters"
            >
              {{ deadLetters.length }} failed sync {{ deadLetters.length === 1 ? "entry" : "entries" }}
            </button>
            <div v-if="showDeadLetters" class="mt-2 space-y-2 max-h-40 overflow-y-auto">
              <div
                v-for="entry in deadLetters"
                :key="entry.id"
                class="bg-elevated rounded-[var(--r-sm)] px-2 py-1.5"
              >
                <div class="font-mono text-[10px] truncate">
                  {{ entry.op }} · {{ entry.collection }} · {{ entry.recordKey }}
                </div>
                <div class="text-red-400 text-[10px] mt-0.5 truncate" :title="entry.error">
                  {{ entry.error }}
                </div>
              </div>
              <button
                class="w-full text-[11px] py-1 mt-1 text-fg-muted hover:text-red-500"
                @click="onClearDeadLetters"
              >
                Discard all
              </button>
            </div>
          </div>
        </div>

        <button class="btn-pill w-full" :disabled="busy" @click="onSignOut">
          Sign out
        </button>
      </div>

      <form v-else class="space-y-3" @submit.prevent="onSignIn">
        <label class="block text-sm">
          <span class="text-fg-muted">Handle or DID</span>
          <input
            v-model="handle"
            type="text"
            placeholder="alice.bsky.social"
            class="mt-1 w-full px-3 py-2 bg-elevated border border-line rounded-[var(--r-sm)] text-sm"
            autocomplete="username"
            autofocus
          />
        </label>
        <button
          type="submit"
          class="btn-pill w-full"
          style="background: var(--c-accent); color: var(--c-accent-fg)"
          :disabled="busy"
        >
          {{ busy ? "Redirecting…" : "Sign in with AT Protocol" }}
        </button>
        <p v-if="error" class="text-xs text-red-500">{{ error }}</p>
      </form>
    </div>
  </div>
</template>
