// packages/cli/tests/handoff/fixtures/stubs/fake-git.ts
//
// Configurable GitClient fake — branch + dirty flag are setter-driven, and
// every call is recorded in the call log for control-flow assertions in
// verb tests (mirrors bash's GIT_CALLS file). Pairs with FakeGhClient.
import type { GitClient } from "../../../../src/handoff/ports.js";

export class FakeGitClient implements GitClient {
  private _branch = "feature/x";
  private _dirty = false;
  private _calls: string[] = [];

  setBranch(b: string) {
    this._branch = b;
  }
  setDirty(d: boolean) {
    this._dirty = d;
  }
  calls(): readonly string[] {
    return this._calls;
  }

  async currentBranch(): Promise<string> {
    this._calls.push("git rev-parse --abbrev-ref HEAD");
    return this._branch;
  }
  async isDirty(): Promise<boolean> {
    this._calls.push("git diff --quiet");
    return this._dirty;
  }
}
