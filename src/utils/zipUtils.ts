import type { Entry, FileEntry } from "@zip-js/zip-js";

/**
 * Type guard to check if a zip Entry has getData (i.e. is a file, not a directory).
 */
export function isFileEntry(entry: Entry): entry is FileEntry {
  return !entry.directory;
}
