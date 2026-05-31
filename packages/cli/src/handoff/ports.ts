// packages/cli/src/handoff/ports.ts
//
// Stub for Task 3 — Task 4 expands this with GhClient/GitClient/Clock interfaces
// and a savedNotePath field. Keep the API stable across the expansion (Task 4
// will only ADD members, never break the existing surface).

export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffError";
  }
}
