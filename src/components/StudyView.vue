<script setup lang="ts">
import { onMounted, ref, watch, nextTick, onBeforeUnmount } from "vue";
import { useStudy } from "../composables/useStudy";
import { useCardRenderer } from "../composables/useCardRenderer";
import type { Answer } from "../scheduler/types";

const props = defineProps<{
  deckTid: string;
  deckUri: string;
}>();

const emit = defineEmits<{
  finish: [];
}>();

const {
  currentCard,
  isShowingAnswer,
  isFinished,
  canUndo,
  counts,
  progress,
  startStudy,
  showAnswer,
  answerCard,
  undo,
  getIntervals,
} = useStudy();

const { buildSrcdoc, resolveMediaInHtml, clearMediaCache } = useCardRenderer();

const iframeRef = ref<HTMLIFrameElement>();
const renderedHtml = ref("");
const intervals = ref<Record<Answer, string>>({ again: "?", hard: "?", good: "?", easy: "?" });

onMounted(async () => {
  await startStudy(props.deckTid, props.deckUri);
  await renderCurrentCard();
});

onBeforeUnmount(() => {
  clearMediaCache();
});

watch([currentCard, isShowingAnswer], async () => {
  await renderCurrentCard();
});

watch(currentCard, () => {
  if (currentCard.value) {
    intervals.value = getIntervals();
  }
});

async function renderCurrentCard() {
  if (!currentCard.value) {
    renderedHtml.value = "";
    return;
  }
  let html = buildSrcdoc(currentCard.value, isShowingAnswer.value);
  html = await resolveMediaInHtml(html);
  renderedHtml.value = html;
  await nextTick();
  setTimeout(setupIframe, 50);
}

function setupIframe() {
  const iframe = iframeRef.value;
  if (!iframe?.contentDocument?.body) return;
  const doc = iframe.contentDocument;

  for (const hint of doc.querySelectorAll<HTMLElement>(".hint")) {
    hint.addEventListener("click", () => {
      const content = hint.getAttribute("data-hint");
      if (content) hint.textContent = content;
    });
  }

  for (const btn of doc.querySelectorAll<HTMLElement>(".audio-container button")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const audio = btn
        .closest(".audio-container")
        ?.querySelector("audio") as HTMLAudioElement | null;
      if (audio) {
        audio.currentTime = 0;
        audio.play();
      }
    });
  }

  const autoplayContainers = doc.querySelectorAll<HTMLElement>(".audio-container[data-autoplay]");
  if (autoplayContainers.length > 0) {
    const firstAudio = autoplayContainers[0]?.querySelector("audio") as HTMLAudioElement | null;
    if (firstAudio) {
      setTimeout(() => firstAudio.play().catch(() => {}), 100);
    }
  }
}

function handleShowAnswer() {
  showAnswer();
}

async function handleAnswer(answer: Answer) {
  await answerCard(answer);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

  if (!isShowingAnswer.value) {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      handleShowAnswer();
    }
  } else {
    if (e.key === "1") handleAnswer("again");
    else if (e.key === "2") handleAnswer("hard");
    else if (e.key === "3") handleAnswer("good");
    else if (e.key === "4") handleAnswer("easy");
    else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      handleAnswer("good");
    }
  }

  if (e.key === "z" && (e.ctrlKey || e.metaKey) && canUndo.value) {
    e.preventDefault();
    undo();
  }
}

onMounted(() => document.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", handleKeydown));

const ANSWER_BUTTONS: {
  answer: Answer;
  label: string;
  key: string;
  cssVar: string;
  soft: string;
}[] = [
  { answer: "again", label: "Again", key: "1", cssVar: "--c-again", soft: "--c-again-soft" },
  { answer: "hard", label: "Hard", key: "2", cssVar: "--c-hard", soft: "--c-hard-soft" },
  { answer: "good", label: "Good", key: "3", cssVar: "--c-good", soft: "--c-good-soft" },
  { answer: "easy", label: "Easy", key: "4", cssVar: "--c-easy", soft: "--c-easy-soft" },
];
</script>

<template>
  <div class="max-w-3xl mx-auto px-4 pt-6 pb-8 flex flex-col items-center">
    <!-- Counts bar -->
    <div class="flex justify-center gap-5 mb-5 text-sm tabular-nums">
      <span class="font-semibold" style="color: var(--c-new)">{{ counts.newCount }}</span>
      <span class="text-fg-faint">·</span>
      <span class="font-semibold" style="color: var(--c-learn)">{{ counts.learnCount }}</span>
      <span class="text-fg-faint">·</span>
      <span class="font-semibold" style="color: var(--c-due)">{{ counts.dueCount }}</span>
    </div>

    <!-- Finished screen -->
    <div
      v-if="isFinished"
      class="card flex items-center justify-center w-full max-w-[720px]"
      style="aspect-ratio: 3 / 2"
    >
      <div class="text-center px-8">
        <div class="text-5xl mb-3">✦</div>
        <p class="text-2xl font-semibold mb-2">All done for now</p>
        <p class="text-fg-muted mb-6">
          {{ progress.newStudied }} new and {{ progress.reviewsStudied }} reviews studied today.
        </p>
        <button class="btn-primary px-6 py-2.5" @click="emit('finish')">Back to decks</button>
      </div>
    </div>

    <!-- Card surface — fixed 3:2 aspect, scrolls inside -->
    <div v-else class="w-full flex flex-col items-center gap-5">
      <div
        class="card w-full max-w-[720px] overflow-hidden shadow-soft"
        style="aspect-ratio: 3 / 2"
      >
        <iframe
          v-if="renderedHtml"
          ref="iframeRef"
          :srcdoc="renderedHtml"
          sandbox="allow-same-origin allow-scripts"
          class="w-full h-full border-0 block"
        />
      </div>

      <!-- Answer buttons / controls -->
      <div class="w-full max-w-[720px]">
        <div v-if="!isShowingAnswer" class="flex justify-center items-center gap-3">
          <button v-if="canUndo" class="btn-secondary" @click="undo">Undo</button>
          <button
            class="px-10 py-3 rounded-[var(--r-md)] font-medium text-[15px] bg-fg text-canvas hover:opacity-90"
            @click="handleShowAnswer"
          >
            Show answer
            <span class="text-fg-faint ml-2 text-xs font-normal">Space</span>
          </button>
        </div>

        <div v-else class="grid grid-cols-4 gap-2">
          <button
            v-for="btn in ANSWER_BUTTONS"
            :key="btn.answer"
            class="group relative flex flex-col items-center justify-center py-3 rounded-[var(--r-md)] border font-medium transition-colors"
            :style="{
              background: `var(${btn.soft})`,
              borderColor: `var(${btn.soft})`,
              color: `var(${btn.cssVar})`,
            }"
            @click="handleAnswer(btn.answer)"
            @mouseover="
              (e) => ((e.currentTarget as HTMLElement).style.borderColor = `var(${btn.cssVar})`)
            "
            @mouseleave="
              (e) => ((e.currentTarget as HTMLElement).style.borderColor = `var(${btn.soft})`)
            "
          >
            <span class="text-[11px] opacity-75 leading-none mb-1">{{
              intervals[btn.answer]
            }}</span>
            <span class="text-sm leading-none">{{ btn.label }}</span>
            <span class="absolute top-1.5 right-2 text-[10px] font-normal opacity-50">{{
              btn.key
            }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
