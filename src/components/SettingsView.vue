<script setup lang="ts">
import { ref, onMounted } from "vue";
import type { DeckSettingsRecord } from "../db/schema";
import { deckSettingsDb, settingsDb, APP_DEFAULTS } from "../db/settings";

const props = defineProps<{
  deckTid: string;
  deckUri: string;
  deckName: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const algorithm = ref<"sm2" | "fsrs">("fsrs");
const newCardsPerDay = ref(20);
const reviewsPerDay = ref(200);
const learningSteps = ref("1 10");
const relearningSteps = ref("10");
const startingEase = ref(2.5);
const maximumInterval = ref(36500);
const leechThreshold = ref(8);
const desiredRetention = ref(0.9);
const buryNewSiblings = ref(true);
const buryReviewSiblings = ref(true);

onMounted(async () => {
  const resolved = await deckSettingsDb.getResolved(props.deckTid);
  algorithm.value = resolved.algorithm;
  newCardsPerDay.value = resolved.newCardsPerDay;
  reviewsPerDay.value = resolved.reviewsPerDay;
  learningSteps.value = resolved.learningSteps.join(" ");
  relearningSteps.value = resolved.relearningSteps.join(" ");
  startingEase.value = resolved.startingEase;
  maximumInterval.value = resolved.maximumInterval;
  leechThreshold.value = resolved.leechThreshold;
  desiredRetention.value = resolved.desiredRetention;
  buryNewSiblings.value = resolved.buryNewSiblings;
  buryReviewSiblings.value = resolved.buryReviewSiblings;
});

async function save() {
  const ds: DeckSettingsRecord = {
    deckTid: props.deckTid,
    deck: props.deckUri,
    algorithm: algorithm.value,
    newCardsPerDay: newCardsPerDay.value,
    reviewsPerDay: reviewsPerDay.value,
    learningSteps: learningSteps.value
      .split(/\s+/)
      .map(Number)
      .filter((n) => n > 0),
    relearningSteps: relearningSteps.value
      .split(/\s+/)
      .map(Number)
      .filter((n) => n > 0),
    startingEase: startingEase.value,
    maximumInterval: maximumInterval.value,
    leechThreshold: leechThreshold.value,
    desiredRetention: desiredRetention.value,
    buryNewSiblings: buryNewSiblings.value,
    buryReviewSiblings: buryReviewSiblings.value,
    updatedAt: new Date().toISOString(),
  };
  await deckSettingsDb.put(ds);
  emit("close");
}
</script>

<template>
  <div class="max-w-lg mx-auto px-4 py-6">
    <div class="flex justify-between items-center mb-6">
      <div>
        <p class="text-xs uppercase tracking-wider text-fg-subtle font-semibold mb-0.5">
          Deck settings
        </p>
        <h2 class="text-xl font-semibold tracking-tight">{{ deckName }}</h2>
      </div>
      <button class="btn-icon" aria-label="Close" @click="emit('close')">✕</button>
    </div>

    <div class="card p-5 space-y-4">
      <div>
        <label class="field-label">Algorithm</label>
        <select v-model="algorithm" class="field-input">
          <option value="fsrs">FSRS</option>
          <option value="sm2">SM-2</option>
        </select>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label">New cards/day</label>
          <input v-model.number="newCardsPerDay" type="number" min="0" class="field-input" />
        </div>
        <div>
          <label class="field-label">Reviews/day</label>
          <input v-model.number="reviewsPerDay" type="number" min="0" class="field-input" />
        </div>
      </div>

      <div>
        <label class="field-label">Learning steps (minutes)</label>
        <input v-model="learningSteps" type="text" class="field-input" placeholder="1 10" />
      </div>

      <div>
        <label class="field-label">Relearning steps (minutes)</label>
        <input v-model="relearningSteps" type="text" class="field-input" placeholder="10" />
      </div>

      <div v-if="algorithm === 'fsrs'">
        <label class="field-label">Desired retention</label>
        <input
          v-model.number="desiredRetention"
          type="number"
          min="0.5"
          max="0.99"
          step="0.01"
          class="field-input"
        />
      </div>

      <div v-if="algorithm === 'sm2'">
        <label class="field-label">Starting ease</label>
        <input
          v-model.number="startingEase"
          type="number"
          min="1.3"
          step="0.1"
          class="field-input"
        />
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label">Max interval (days)</label>
          <input v-model.number="maximumInterval" type="number" min="1" class="field-input" />
        </div>
        <div>
          <label class="field-label">Leech threshold</label>
          <input v-model.number="leechThreshold" type="number" min="1" class="field-input" />
        </div>
      </div>

      <div class="space-y-2 pt-1">
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input v-model="buryNewSiblings" type="checkbox" />
          Bury new siblings
        </label>
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input v-model="buryReviewSiblings" type="checkbox" />
          Bury review siblings
        </label>
      </div>
    </div>

    <div class="flex gap-2 mt-5">
      <button class="btn-primary" @click="save">Save changes</button>
      <button class="btn-secondary" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>
