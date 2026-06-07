import { ref } from "vue";
import { getAnkiDataFromBlob } from "../ankiParser/index";
import { importAnkiData, type ImportProgress, type ImportResult } from "../import/apkgImport";

const isImporting = ref(false);
const importProgress = ref<ImportProgress | null>(null);
const lastResult = ref<ImportResult | null>(null);
const importError = ref<string | null>(null);

export function useImport() {
  async function importFile(file: File): Promise<ImportResult | null> {
    isImporting.value = true;
    importProgress.value = null;
    importError.value = null;
    lastResult.value = null;

    try {
      const blob = new Blob([await file.arrayBuffer()]);
      const ankiData = await getAnkiDataFromBlob(blob);
      const result = await importAnkiData(ankiData, (p) => {
        importProgress.value = p;
      });
      lastResult.value = result;
      return result;
    } catch (e) {
      importError.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      isImporting.value = false;
    }
  }

  return {
    isImporting,
    importProgress,
    lastResult,
    importError,
    importFile,
  };
}
