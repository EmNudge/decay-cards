<script setup lang="ts">
import { ref } from "vue";
import { useImport } from "../composables/useImport";

const emit = defineEmits<{
  done: [];
}>();

const { isImporting, importProgress, lastResult, importError, importFile } = useImport();
const fileInput = ref<HTMLInputElement>();

async function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  await importFile(file);
}

function triggerFileSelect() {
  fileInput.value?.click();
}
</script>

<template>
  <div class="max-w-xl mx-auto px-4 py-6">
    <h2 class="text-xl font-semibold mb-5 tracking-tight">Import .apkg file</h2>

    <input
      ref="fileInput"
      type="file"
      accept=".apkg,.colpkg"
      class="hidden"
      @change="handleFileSelect"
    />

    <!-- File picker -->
    <div
      v-if="!isImporting && !lastResult"
      class="border-2 border-dashed border-line-strong rounded-[var(--r-lg)] p-14 text-center cursor-pointer hover:border-accent hover:bg-accent-soft"
      @click="triggerFileSelect"
    >
      <div class="text-4xl mb-3 opacity-50">↧</div>
      <p class="font-medium mb-1">Click to select a file</p>
      <p class="text-sm text-fg-muted">Supports .apkg and .colpkg files</p>
    </div>

    <!-- Progress -->
    <div v-if="isImporting" class="card p-8 text-center">
      <p class="text-lg font-semibold mb-2">Importing…</p>
      <p v-if="importProgress" class="text-fg-muted text-sm">
        {{ importProgress.phase }}: {{ importProgress.current }} / {{ importProgress.total }}
      </p>
    </div>

    <!-- Error -->
    <div
      v-if="importError"
      class="rounded-[var(--r-md)] p-4 mb-4 border"
      :style="{
        background: 'var(--c-again-soft)',
        borderColor: 'var(--c-again)',
        color: 'var(--c-again)',
      }"
    >
      <p class="font-medium">{{ importError }}</p>
    </div>

    <!-- Result -->
    <div v-if="lastResult" class="space-y-4">
      <div
        class="rounded-[var(--r-lg)] p-5 border"
        :style="{ background: 'var(--c-good-soft)', borderColor: 'var(--c-good)' }"
      >
        <p class="font-semibold mb-2" :style="{ color: 'var(--c-good)' }">Import complete</p>
        <ul class="text-sm space-y-1 text-fg">
          <li>{{ lastResult.decksCreated }} deck(s) created</li>
          <li>{{ lastResult.noteTypesCreated }} note type(s)</li>
          <li>{{ lastResult.notesCreated }} note(s) created</li>
          <li v-if="lastResult.notesUpdated > 0">{{ lastResult.notesUpdated }} note(s) updated</li>
          <li v-if="lastResult.notesSkipped > 0">
            {{ lastResult.notesSkipped }} note(s) skipped (duplicates)
          </li>
          <li v-if="lastResult.reviewStatesCreated > 0">
            {{ lastResult.reviewStatesCreated }} review state(s)
          </li>
          <li v-if="lastResult.mediaCreated > 0">{{ lastResult.mediaCreated }} media file(s)</li>
        </ul>
      </div>

      <div class="flex gap-2">
        <button class="btn-primary" @click="emit('done')">Start studying</button>
        <button class="btn-secondary" @click="triggerFileSelect">Import another</button>
      </div>
    </div>
  </div>
</template>
