import { Problem } from "./library";

// Bounded per-process import work shared by every import source; there is
// only one owner per instance, so one pool covers GitHub and GitLab.
let active = 0;
let starts: number[] = [];

// Tests exercise many imports across files sharing this process.
export function resetImportLimit() {
  active = 0;
  starts = [];
}

export function claimImport(): () => void {
  const now = Date.now();
  starts = starts.filter((t) => now - t < 60_000);
  if (active >= 2 || starts.length >= 12)
    throw new Problem(429, "Import limit reached; try again shortly");
  active++;
  starts.push(now);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active--;
    }
  };
}
