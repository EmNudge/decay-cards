import { ref, shallowRef, computed } from "vue";
import type { ReviewStateRecord } from "../db/schema";
import { StudyQueue, type StudyCard } from "../scheduler/studyQueue";
import type { Answer } from "../scheduler/types";

const queue = shallowRef<StudyQueue | null>(null);
const dueCards = shallowRef<StudyCard[]>([]);
const currentIndex = ref(0);
const isShowingAnswer = ref(false);
const reviewStartTime = ref(0);
const undoSnapshot = shallowRef<{ state: ReviewStateRecord; logTid: string } | null>(null);

export function useStudy() {
  const currentCard = computed(() => dueCards.value[currentIndex.value] ?? null);
  const isFinished = computed(
    () => dueCards.value.length === 0 || currentIndex.value >= dueCards.value.length,
  );
  const canUndo = computed(() => undoSnapshot.value !== null);

  const counts = computed(
    () => queue.value?.getCounts() ?? { newCount: 0, learnCount: 0, dueCount: 0 },
  );
  const progress = computed(
    () =>
      queue.value?.getProgress() ?? {
        newStudied: 0,
        reviewsStudied: 0,
        newLimit: 20,
        reviewLimit: 200,
      },
  );

  async function startStudy(deckTid: string, deckUri: string) {
    const q = new StudyQueue(deckTid, deckUri);
    await q.init();
    queue.value = q;
    refreshDueCards();
  }

  function refreshDueCards() {
    if (!queue.value) return;
    dueCards.value = queue.value.getDueCards();
    currentIndex.value = 0;
    isShowingAnswer.value = false;
    reviewStartTime.value = Date.now();
  }

  function showAnswer() {
    isShowingAnswer.value = true;
  }

  async function answerCard(answer: Answer) {
    const card = currentCard.value;
    if (!card || !queue.value) return;

    // Snapshot for undo (before processing)
    const prevState = { ...card.reviewState };

    const timeMs = Date.now() - reviewStartTime.value;
    const { card: _updated, logTid } = await queue.value.processReview(card, answer, timeMs);

    undoSnapshot.value = { state: prevState, logTid };

    // Refresh the queue
    refreshDueCards();
  }

  async function undo() {
    if (!undoSnapshot.value || !queue.value) return;
    await queue.value.undo(undoSnapshot.value.state, undoSnapshot.value.logTid);
    undoSnapshot.value = null;
    refreshDueCards();
  }

  function getIntervals(): Record<Answer, string> {
    const card = currentCard.value;
    if (!card || !queue.value) return { again: "?", hard: "?", good: "?", easy: "?" };
    return queue.value.getNextIntervals(card);
  }

  return {
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
  };
}
