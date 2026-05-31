// packages/cli/tests/handoff/fixtures/stubs/fake-gh.ts
//
// Queue-based ordinal-keyed GhClient fake. Tests register per-call responses
// via per-method slot maps. Each call to a method picks slot N (call ordinal,
// 1-indexed). If no slot configured for N, falls back to slot 0 (default).
// If neither exists, throws "no slot configured" — catches under-stubbed tests.
//
// This is the TS counterpart to the bash stub at
// momentiq-ai/dark-factory-platform/.claude/skills/handoff/tests/bin/gh@a6f711b.
// The per-method dual-counter pattern (STUB_ISSUE_BODY_N for body-bearing
// vs STUB_ISSUE_ASSIGNEES_VN for body-less) maps to the GhClient interface's
// issueView vs issueViewSlim split — each method has its own counter
// automatically.
//
// Records every call in this.calls() for control-flow assertions in verb tests.

import type {
  GhClient,
  IssueCreated,
  IssueListItem,
  IssueView,
  IssueViewSlim,
  PrView,
} from "../../../../src/handoff/ports.js";

type Result<T> = T | Error;

/** Per-method slot map: 0 = default, N ≥ 1 = override Nth call. */
class SlotMap<T> {
  private slots = new Map<number, Result<T>>();
  setDefault(v: T | Error) {
    this.slots.set(0, v);
  }
  setSlot(ordinal: number, v: T | Error) {
    this.slots.set(ordinal, v);
  }
  pick(ordinal: number): Result<T> | undefined {
    if (this.slots.has(ordinal)) return this.slots.get(ordinal)!;
    if (this.slots.has(0)) return this.slots.get(0)!;
    return undefined;
  }
  clear() {
    this.slots.clear();
  }
}

export class FakeGhClient implements GhClient {
  // Per-method slot maps.
  private _issueView = new SlotMap<IssueView>();
  private _issueViewSlim = new SlotMap<IssueViewSlim>();
  private _issueList = new SlotMap<readonly IssueListItem[]>();
  private _issueCreate = new SlotMap<IssueCreated>();
  /** prView is keyed by PR number too (per-PR slot maps). */
  private _prView = new Map<number, SlotMap<PrView>>();
  /** PR list keyed by branch. */
  private _prListByHead = new SlotMap<
    ReadonlyArray<{ number: number; title: string }>
  >();

  // @me login (defaults to "alien8d" to match the bash stub's STUB_ME).
  private _meLogin = "alien8d";

  // Call log — every method records its invocation as a string for
  // control-flow assertions (mirrors bash's GH_CALLS file).
  private _calls: string[] = [];

  // Per-method counters.
  private _counters = new Map<string, number>();

  // Hooks for mutating-call side effects (tests can inspect bodies sent
  // via issueEditBody/issueCreate).
  private _lastEditBody: { num: number; bodyMd: string } | undefined;
  private _lastCreateBody:
    | { title: string; bodyMd: string; label: string }
    | undefined;

  // Optional throw-on-close hook for the /accept close-failure recovery test.
  // The bash stub honors STUB_ISSUE_CLOSE_RC=1; this is the TS analog. Log
  // happens BEFORE the throw so call-sequence assertions still see the close.
  private _issueCloseThrows: Error | undefined;

  // ----- configurators (tests use these) -----
  setMeLogin(login: string) {
    this._meLogin = login;
  }
  setIssueViewDefault(v: IssueView) {
    this._issueView.setDefault(v);
  }
  setIssueViewSlot(ordinal: number, v: IssueView | Error) {
    this._issueView.setSlot(ordinal, v);
  }
  setIssueViewSlimDefault(v: IssueViewSlim) {
    this._issueViewSlim.setDefault(v);
  }
  setIssueViewSlimSlot(ordinal: number, v: IssueViewSlim | Error) {
    this._issueViewSlim.setSlot(ordinal, v);
  }
  setIssueListDefault(list: readonly IssueListItem[]) {
    this._issueList.setDefault(list);
  }
  setIssueListSlot(ordinal: number, v: readonly IssueListItem[] | Error) {
    this._issueList.setSlot(ordinal, v);
  }
  setIssueCreateDefault(v: IssueCreated) {
    this._issueCreate.setDefault(v);
  }
  setPrViewDefault(num: number, v: PrView | Error) {
    if (!this._prView.has(num)) this._prView.set(num, new SlotMap<PrView>());
    this._prView.get(num)!.setDefault(v as PrView); // SlotMap accepts T|Error
  }
  setPrViewSlot(num: number, ordinal: number, v: PrView | Error) {
    if (!this._prView.has(num)) this._prView.set(num, new SlotMap<PrView>());
    this._prView.get(num)!.setSlot(ordinal, v);
  }
  /** Make every PR view throw (parity with bash STUB_PR_VIEW_RC=1). */
  setAllPrViewsThrow(err: Error = new Error("gh pr view failed (stubbed)")) {
    // Add a sentinel slot map for num=0 that catches all PR view requests
    // not specifically configured.
    if (!this._prView.has(0)) this._prView.set(0, new SlotMap<PrView>());
    this._prView.get(0)!.setDefault(err);
  }
  setPrListByHeadDefault(
    list: ReadonlyArray<{ number: number; title: string }>,
  ) {
    this._prListByHead.setDefault(list);
  }
  /** Force `issueClose` to throw (parity with bash STUB_ISSUE_CLOSE_RC=1). */
  setIssueCloseThrows(err: Error = new Error("gh issue close failed (stubbed)")) {
    this._issueCloseThrows = err;
  }

  // ----- inspection -----
  calls(): readonly string[] {
    return this._calls;
  }
  lastEditBody(): { num: number; bodyMd: string } | undefined {
    return this._lastEditBody;
  }
  lastCreateBody():
    | { title: string; bodyMd: string; label: string }
    | undefined {
    return this._lastCreateBody;
  }

  // ----- helpers -----
  private bump(key: string): number {
    const n = (this._counters.get(key) ?? 0) + 1;
    this._counters.set(key, n);
    return n;
  }
  private throwOrReturn<T>(v: Result<T> | undefined, what: string): T {
    if (v === undefined) {
      throw new Error(
        `fake-gh: no slot configured for ${what} (configure via set${what.charAt(0).toUpperCase() + what.slice(1)}Default or ...Slot)`,
      );
    }
    if (v instanceof Error) throw v;
    return v;
  }
  private log(s: string) {
    this._calls.push(s);
  }

  // ----- GhClient interface -----
  async authStatus(): Promise<void> {
    this.log("gh auth status");
  }
  async apiUserLogin(): Promise<string> {
    this.log("gh api user --jq .login");
    return this._meLogin;
  }
  async ensureHandoffLabel(): Promise<void> {
    this.log("gh label create handoff");
  }

  async issueView(
    num: number,
    opts: { repo?: string } = {},
  ): Promise<IssueView> {
    const n = this.bump("issueView");
    this.log(
      `gh issue view ${num}${opts.repo ? ` --repo ${opts.repo}` : ""} (slot ${n})`,
    );
    return this.throwOrReturn(this._issueView.pick(n), "issueView");
  }
  async issueViewSlim(
    num: number,
    opts: { repo?: string } = {},
  ): Promise<IssueViewSlim> {
    const n = this.bump("issueViewSlim");
    this.log(
      `gh issue view ${num}${opts.repo ? ` --repo ${opts.repo}` : ""} --slim (slot ${n})`,
    );
    return this.throwOrReturn(this._issueViewSlim.pick(n), "issueViewSlim");
  }
  async issueList(opts: {
    state: "open" | "closed";
    assignee?: "@me" | string;
    search?: string;
  }): Promise<readonly IssueListItem[]> {
    const n = this.bump("issueList");
    this.log(
      `gh issue list --state ${opts.state}${opts.assignee ? ` --assignee ${opts.assignee}` : ""}${opts.search ? ` --search ${opts.search}` : ""} (slot ${n})`,
    );
    return this.throwOrReturn(this._issueList.pick(n), "issueList");
  }
  async issueCreate(opts: {
    title: string;
    bodyMd: string;
    label: string;
  }): Promise<IssueCreated> {
    const n = this.bump("issueCreate");
    this.log(
      `gh issue create --title ${JSON.stringify(opts.title)} --label ${opts.label} (slot ${n})`,
    );
    this._lastCreateBody = opts;
    const fallback: IssueCreated = {
      number: 999,
      url: "https://github.com/o/r/issues/999",
    };
    const picked = this._issueCreate.pick(n);
    return picked !== undefined
      ? this.throwOrReturn(picked, "issueCreate")
      : fallback;
  }
  async issueEditBody(num: number, bodyMd: string): Promise<void> {
    this.log(`gh issue edit ${num} --body-file (len=${bodyMd.length})`);
    this._lastEditBody = { num, bodyMd };
  }
  async issueAddLabel(num: number, label: string): Promise<void> {
    this.log(`gh issue edit ${num} --add-label ${label}`);
  }
  async issueAssignMe(num: number): Promise<void> {
    this.log(`gh issue edit ${num} --add-assignee @me`);
  }
  async issueUnassignMe(num: number): Promise<void> {
    this.log(`gh issue edit ${num} --remove-assignee @me`);
  }
  async issueClose(num: number): Promise<void> {
    // Log BEFORE throwing so call-sequence assertions (used by the
    // close-failure recovery test) still see this call.
    this.log(`gh issue close ${num}`);
    if (this._issueCloseThrows) throw this._issueCloseThrows;
  }

  async prView(num: number, opts: { repo?: string } = {}): Promise<PrView> {
    // Per-PR slot map; fall back to num=0 sentinel (setAllPrViewsThrow uses 0).
    const map = this._prView.get(num) ?? this._prView.get(0);
    if (!map) {
      throw new Error(
        `fake-gh: no prView slot for ${num} (configure via setPrViewDefault(${num}, ...) or setAllPrViewsThrow())`,
      );
    }
    const n = this.bump(`prView:${num}`);
    this.log(
      `gh pr view ${num}${opts.repo ? ` --repo ${opts.repo}` : ""} (slot ${n})`,
    );
    return this.throwOrReturn(map.pick(n), `prView ${num}`);
  }

  async prListByHead(
    branch: string,
  ): Promise<ReadonlyArray<{ number: number; title: string }>> {
    const n = this.bump("prListByHead");
    this.log(`gh pr list --head ${branch} (slot ${n})`);
    const picked = this._prListByHead.pick(n);
    return picked !== undefined
      ? this.throwOrReturn(picked, "prListByHead")
      : [];
  }
}
