import { ref } from "vue";

interface FlagDefinition {
  flag: number;
  label: string;
  color: string;
}

const DEFAULT_FLAGS: FlagDefinition[] = [
  { flag: 1, label: "Red", color: "#ff6b6b" },
  { flag: 2, label: "Orange", color: "#ffa94d" },
  { flag: 3, label: "Green", color: "#69db7c" },
  { flag: 4, label: "Blue", color: "#74c0fc" },
  { flag: 5, label: "Pink", color: "#f783ac" },
  { flag: 6, label: "Turquoise", color: "#63e6be" },
  { flag: 7, label: "Purple", color: "#b197fc" },
];

const STORAGE_KEY = "custom-flag-labels";

function loadCustomLabels(): Record<number, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Reactive ref holding custom flag label overrides (flag number → custom name) */
export const customFlagLabelsSig = ref<Record<number, string>>(loadCustomLabels());

/** Get the resolved flag definitions, with custom labels applied */
export function getFlags(): FlagDefinition[] {
  const custom = customFlagLabelsSig.value;
  return DEFAULT_FLAGS.map((f) => ({
    ...f,
    label: custom[f.flag] || f.label,
  }));
}
