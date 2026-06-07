/**
 * Return a shallow copy of `obj` with all keys whose value is `undefined` removed.
 * Useful for satisfying `exactOptionalPropertyTypes` when building objects with
 * optional fields that may or may not be present.
 *
 * The return type makes every key that could be undefined optional, so the
 * result can be assigned to types with strict optional properties.
 */
type StripUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function omitUndefined<T extends object>(obj: T): StripUndefined<T> {
  const out: Record<string, unknown> = {};
  for (const k in obj) {
    const v = obj[k];
    if (v !== undefined) out[k] = v;
  }
  return out as StripUndefined<T>;
}
