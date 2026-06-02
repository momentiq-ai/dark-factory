// packages/cli/tests/handoff/handoff-verb.test.ts
//
// Ported from .claude/skills/handoff/tests/test_handoff.sh (the bash spec).
// Each test cites the source `t_handoff_*` function in a comment near the top.
//
// Coverage groups:
//   1. Explicit-issue path  (upsert / refuse-closed / refuse-non-handoff /
//      empty-shell accept / assignees guard {other,me} / unverifiable)
//   2. No-arg path  (no-existing creates, my-claimed advisory, my-empty
//      updates, 1-eligible+1-claimed picker, list-fails-closed,
//      2-eligible dies, one-eligible-one-claimed-advisory)
//   3. Secret-scrub refusals (AWS, sk-ant, connstring, credpath, envvar)
//   4. Note validation (malformed, multi-block latest malformed)
//   5. Issue arg validation (0, non-numeric, semicolon)
//   6. Dirty worktree (warn, not refuse)
//   7. --link / --unlink (multi, unlink, url form, bare-number cross-repo,
//      link-handoff-refused, link-project-url-deferred, link-url-with-query,
//      link-title-with-tab, link-secret-in-title-refused, link-parse-scoped)
//   8. Auto-link single PR
//   9. Pre-PATCH drift (body, state, assignees)
//  10. Create-title scrub
//  11. Argv hygiene (TRANSFORMED: ;, $(), >)
//  12. Other (unverifiable, idempotent, command_passes_split_args)
//
// The bash assertions transfer 1:1 onto FakeGhClient.calls() / fake state.

import { describe, it, expect } from "vitest";

import { runHandoff } from "../../src/handoff/handoff-verb.js";
import type {
  IssueListItem,
  IssueView,
  PrView,
} from "../../src/handoff/ports.js";
import { FakeGhClient } from "./fixtures/stubs/fake-gh.js";
import { FakeGitClient } from "./fixtures/stubs/fake-git.js";
import { FixedClock } from "./fixtures/stubs/fixed-clock.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

/**
 * Minimal valid agent-context note matching the bash test_handoff.sh
 * `newenv()` default fixture (handoff.sh:42-44).
 */
const NOTE = `${MARK_O}
_Updated: 2026-05-30 by claude-opus-4-8 session_

**Why this approach (and what I rejected):**
- chose path 1 over path 2

**Where I was mid-thought:**
- here
${MARK_C}
`;

/** Body containing exactly one agent-context block — bash body_with_block(). */
function bodyWithBlock(): string {
  return `${MARK_O}\n_Updated: 2026-05-29_\n\nwhy: prior reasoning\n${MARK_C}`;
}

/** Body containing the Linked work items section — bash body_with_links(). */
function bodyWithLinks(entries: string): string {
  return `${MARK_O}\n_Updated: 2026-05-30_\n\n**Linked work items:**\n${entries}\n\nwhy: something\n${MARK_C}`;
}

function setup() {
  const gh = new FakeGhClient();
  const git = new FakeGitClient();
  const clock = new FixedClock(1780142400, "2026-05-30");
  return { gh, git, clock };
}

function issueView(overrides: Partial<IssueView> = {}): IssueView {
  return {
    number: 42,
    title: "Handoff: example",
    body: "",
    state: "OPEN",
    assignees: [],
    labels: [{ name: "handoff" }],
    updatedAt: "2026-05-30T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

function prView(overrides: Partial<PrView> = {}): PrView {
  return {
    title: "PR title",
    state: "OPEN",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [],
    ...overrides,
  };
}

function listItem(overrides: Partial<IssueListItem> & { number: number }): IssueListItem {
  return {
    number: overrides.number,
    title: overrides.title ?? "list item",
    assignees: overrides.assignees ?? [],
    body: overrides.body,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
    closedAt: overrides.closedAt,
  };
}

// ===========================================================================
// 1. Explicit-issue path
// ===========================================================================

describe("/handoff — explicit issue path", () => {
  it("explicit existing handoff issue: body upserted, no create, no push (t_handoff_explicit_issue_upserts_body)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 200, body: bodyWithBlock() }),
    );
    const result = await runHandoff({
      noteStdin: NOTE,
      issue: 200,
      gh,
      git,
      clock,
    });
    expect(result.created).toBe(false);
    expect(result.issueNumber).toBe(200);
    expect(gh.calls().some((c) => c.startsWith("gh issue edit 200 --body-file"))).toBe(true);
    expect(gh.calls().some((c) => c.startsWith("gh issue create"))).toBe(false);
  });

  it("PATCH path returns full html_url (parity with CREATE), not a synthesized #N (#73)", async () => {
    const { gh, git, clock } = setup();
    const url = "https://github.com/momentiq-ai/dark-factory/issues/200";
    gh.setIssueViewDefault(
      issueView({ number: 200, body: bodyWithBlock(), url }),
    );
    const result = await runHandoff({
      noteStdin: NOTE,
      issue: 200,
      gh,
      git,
      clock,
    });
    expect(result.created).toBe(false);
    expect(result.noteUrl).toBe(url);
    expect(result.noteUrl).toMatch(/^https:\/\/github\.com\//);
    expect(result.noteUrl).not.toBe("#200");
  });

  it("PATCH path falls back to #N when issueView returns no url field (defensive)", async () => {
    const { gh, git, clock } = setup();
    // Explicitly no url on the fixture — exercises the fallback branch.
    gh.setIssueViewDefault(
      issueView({ number: 201, body: bodyWithBlock() }),
    );
    const result = await runHandoff({
      noteStdin: NOTE,
      issue: 201,
      gh,
      git,
      clock,
    });
    expect(result.noteUrl).toBe("#201");
  });

  it("refuse on closed handoff issue, no PATCH (t_handoff_refuse_closed_issue)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 88, state: "CLOSED" }),
    );
    await expect(
      runHandoff({ noteStdin: NOTE, issue: 88, gh, git, clock }),
    ).rejects.toThrow(/closed/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 88 --body-file")),
    ).toBe(false);
  });

  it("refuse on non-handoff issue (no handoff label + non-empty body), no PATCH (t_handoff_refuse_non_handoff_issue)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 55,
        labels: [{ name: "bug" }],
        body: "this is an existing bug report",
      }),
    );
    await expect(
      runHandoff({ noteStdin: NOTE, issue: 55, gh, git, clock }),
    ).rejects.toThrow(/not a handoff issue/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 55 --body-file")),
    ).toBe(false);
  });

  it("empty-shell issue (no body, no label) → accepted, body PATCH + label add (t_handoff_accept_empty_shell_issue)", async () => {
    const { gh, git, clock } = setup();
    // Slot 1 (validate): no label, empty body. Slot 2 (pre-PATCH re-fetch):
    // same shape so drift check passes.
    const view = issueView({ number: 66, labels: [], body: "" });
    gh.setIssueViewDefault(view);
    const result = await runHandoff({
      noteStdin: NOTE,
      issue: 66,
      gh,
      git,
      clock,
    });
    expect(result.created).toBe(false);
    expect(gh.calls().some((c) => c.startsWith("gh issue edit 66 --body-file"))).toBe(true);
    expect(gh.calls().some((c) => c === "gh issue edit 66 --add-label handoff")).toBe(true);
  });

  it("explicit /handoff <issue> assigned to @other → refuse with coordinate message (t_handoff_assignees_guard_other)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 100, assignees: [{ login: "other" }] }),
    );
    await expect(
      runHandoff({ noteStdin: NOTE, issue: 100, gh, git, clock }),
    ).rejects.toThrow(/currently assigned to @other/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 100 --body-file")),
    ).toBe(false);
  });

  it("explicit /handoff <issue> assigned to @me → passes (same actor update) (t_handoff_assignees_guard_me_passes)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 100,
        assignees: [{ login: "alien8d" }],
        body: bodyWithBlock(),
      }),
    );
    const result = await runHandoff({
      noteStdin: NOTE,
      issue: 100,
      gh,
      git,
      clock,
    });
    expect(result.created).toBe(false);
    expect(gh.calls().some((c) => c.startsWith("gh issue edit 100 --body-file"))).toBe(true);
  });

  it("unverifiable issue (gh issue view fails) → refuse, no PATCH (t_handoff_issue_unverifiable)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewSlot(1, new Error("gh issue view failed"));
    await expect(
      runHandoff({ noteStdin: NOTE, issue: 99, gh, git, clock }),
    ).rejects.toThrow(/can't verify issue/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 99 --body-file")),
    ).toBe(false);
  });
});

// ===========================================================================
// 2. No-arg path
// ===========================================================================

describe("/handoff — no-arg path", () => {
  it("no-arg + no existing → creates new dedicated issue, NO push, prints URL (t_handoff_noarg_no_existing_creates_new)", async () => {
    const { gh, git, clock } = setup();
    git.setBranch("main");
    gh.setIssueListDefault([]);
    gh.setIssueCreateDefault({
      number: 777,
      url: "https://github.com/o/r/issues/777",
    });
    const result = await runHandoff({ noteStdin: NOTE, gh, git, clock });
    expect(result.created).toBe(true);
    expect(result.issueNumber).toBe(777);
    expect(result.noteUrl).toBe("https://github.com/o/r/issues/777");
    expect(gh.calls().some((c) => c.startsWith("gh issue create"))).toBe(true);
    expect(gh.calls().some((c) => c === "gh issue edit 777 --remove-assignee @me")).toBe(true);
    // No "git push origin" — D4 has no push step.
    expect(git.calls().some((c) => c.includes("push"))).toBe(false);
  });

  it("no-arg + my open #101 claimed by @other → advisory + create new #102, NO #101 PATCH (t_handoff_noarg_assignees_advisory)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueListDefault([
      listItem({
        number: 101,
        title: "old handoff",
        assignees: [{ login: "other" }],
        body: "prior",
      }),
    ]);
    gh.setIssueCreateDefault({
      number: 102,
      url: "https://github.com/o/r/issues/102",
    });
    const result = await runHandoff({ noteStdin: NOTE, gh, git, clock });
    expect(result.created).toBe(true);
    expect(result.issueNumber).toBe(102);
    expect(gh.calls().some((c) => c.startsWith("gh issue create"))).toBe(true);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 101 --body-file")),
    ).toBe(false);
    // Advisory log line.
    expect(result.logs.some((l) => /now claimed by/i.test(l))).toBe(true);
  });

  it("no-arg + my open #101 (assignees empty) → updated, no create, 'updated' notice (t_handoff_noarg_assignees_empty_updates)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueListDefault([
      listItem({
        number: 101,
        title: "old handoff",
        assignees: [],
        body: "prior",
      }),
    ]);
    // After the list picker selects #101, runHandoff calls issueView(101) as
    // slot 1 (validate / fetch full body); then slot 2 (pre-PATCH re-fetch).
    gh.setIssueViewDefault(
      issueView({ number: 101, body: bodyWithBlock() }),
    );
    const result = await runHandoff({ noteStdin: NOTE, gh, git, clock });
    expect(result.created).toBe(false);
    expect(result.issueNumber).toBe(101);
    expect(gh.calls().some((c) => c.startsWith("gh issue edit 101 --body-file"))).toBe(true);
    expect(gh.calls().some((c) => c.startsWith("gh issue create"))).toBe(false);
    expect(result.logs.some((l) => /updated #101/i.test(l))).toBe(true);
  });

  it("no-arg + 1 eligible (#101) + 1 claimed-by-other (#102) → updates #101, NOT 'multiple' (t_handoff_noarg_one_eligible_one_claimed)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueListDefault([
      listItem({
        number: 101,
        title: "mine, eligible",
        assignees: [],
        body: "",
      }),
      listItem({
        number: 102,
        title: "mine, claimed by other",
        assignees: [{ login: "other" }],
        body: "x",
      }),
    ]);
    gh.setIssueViewDefault(
      issueView({ number: 101, body: bodyWithBlock() }),
    );
    const result = await runHandoff({ noteStdin: NOTE, gh, git, clock });
    expect(result.created).toBe(false);
    expect(result.issueNumber).toBe(101);
    expect(gh.calls().some((c) => c.startsWith("gh issue edit 101 --body-file"))).toBe(true);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 102 --body-file")),
    ).toBe(false);
    expect(gh.calls().some((c) => c.startsWith("gh issue create"))).toBe(false);
    // Picker branch must NOT emit "multiple open handoffs".
    // (Logs are collected via result.logs; refuse paths throw.)
  });

  it("gh issue list failure → fail closed, no create, no edit (t_handoff_noarg_list_fails_closed)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueListSlot(1, new Error("gh issue list failed"));
    await expect(
      runHandoff({ noteStdin: NOTE, gh, git, clock }),
    ).rejects.toThrow(/could not query existing handoffs/i);
    expect(gh.calls().some((c) => c.startsWith("gh issue create"))).toBe(false);
    expect(gh.calls().some((c) => c.startsWith("gh issue edit"))).toBe(false);
  });

  it("no-arg + 2 eligible @me handoffs → die 'multiple', no mutation (t_handoff_noarg_two_eligible_dies)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueListDefault([
      listItem({ number: 111, title: "mine A", assignees: [], body: "" }),
      listItem({ number: 112, title: "mine B", assignees: [], body: "" }),
    ]);
    let msg = "";
    try {
      await runHandoff({ noteStdin: NOTE, gh, git, clock });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/multiple open handoffs/i);
    // Error names both numbers (bash assertion: out | grep -qF '#111' && grep '#112').
    expect(msg).toMatch(/#111/);
    expect(msg).toMatch(/#112/);
    expect(gh.calls().some((c) => c.startsWith("gh issue create"))).toBe(false);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 111 --body-file")),
    ).toBe(false);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 112 --body-file")),
    ).toBe(false);
  });
});

// ===========================================================================
// 3. Secret-scrub refusals
// ===========================================================================

describe("/handoff — secret-scrub refusals", () => {
  it("refuses AKIA…, value not echoed (t_handoff_scrub_refuses_aws)", async () => {
    const { gh, git, clock } = setup();
    const aws = "AKIAIOSFODNN7EXAMPLE";
    const noteWithSecret = `${MARK_O}\nleftover debug line: ${aws}\n${MARK_C}\n`;
    let msg = "";
    try {
      await runHandoff({
        noteStdin: noteWithSecret,
        issue: 42,
        gh,
        git,
        clock,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/secret-shaped content/i);
    expect(msg).not.toContain(aws);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("refuses provider key (sk-ant-…), value not echoed (t_handoff_scrub_refuses_provider_key)", async () => {
    const { gh, git, clock } = setup();
    const skant = "sk-ant-api03-FAKEKEYvalue0123456789abcdef";
    const noteWithSecret = `${MARK_O}\nleftover: ${skant}\n${MARK_C}\n`;
    let msg = "";
    try {
      await runHandoff({
        noteStdin: noteWithSecret,
        issue: 42,
        gh,
        git,
        clock,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/secret-shaped content/i);
    expect(msg).not.toContain("sk-ant");
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("refuses credentialed URL (scheme://u:p@host), password not echoed (t_handoff_scrub_refuses_connstring)", async () => {
    const { gh, git, clock } = setup();
    const password = "hunter2";
    const conn = `postgres://admin:${password}@db.internal:5432/app`;
    const noteWithSecret = `${MARK_O}\nleftover: ${conn}\n${MARK_C}\n`;
    let msg = "";
    try {
      await runHandoff({
        noteStdin: noteWithSecret,
        issue: 42,
        gh,
        git,
        clock,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/secret-shaped content/i);
    expect(msg).not.toContain(password);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("refuses credential path (~/.aws/credentials) (t_handoff_scrub_refuses_credpath)", async () => {
    const { gh, git, clock } = setup();
    const noteWithSecret = `${MARK_O}\nthe app key lives in ~/.aws/credentials on the box\n${MARK_C}\n`;
    let msg = "";
    try {
      await runHandoff({
        noteStdin: noteWithSecret,
        issue: 42,
        gh,
        git,
        clock,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/secret-shaped content/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("refuses env-var secret (AWS_SECRET_ACCESS_KEY=…), value not echoed (t_handoff_scrub_refuses_envvar)", async () => {
    const { gh, git, clock } = setup();
    const value = "FAKEsecretvalueEXAMPLE0123456789";
    const noteWithSecret = `${MARK_O}\nAWS_SECRET_ACCESS_KEY=${value}\n${MARK_C}\n`;
    let msg = "";
    try {
      await runHandoff({
        noteStdin: noteWithSecret,
        issue: 42,
        gh,
        git,
        clock,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/secret-shaped content/i);
    expect(msg).not.toContain(value);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });
});

// ===========================================================================
// 4. Note validation
// ===========================================================================

describe("/handoff — note validation", () => {
  it("malformed note (no markers) → rejected, no PATCH (t_handoff_malformed_note)", async () => {
    const { gh, git, clock } = setup();
    await expect(
      runHandoff({
        noteStdin: "just some text, no agent-context markers at all\n",
        issue: 42,
        gh,
        git,
        clock,
      }),
    ).rejects.toThrow(/marker/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("empty stdin → 'empty note body' error, no PATCH", async () => {
    const { gh, git, clock } = setup();
    await expect(
      runHandoff({ noteStdin: "", issue: 42, gh, git, clock }),
    ).rejects.toThrow(/empty note body/i);
    expect(gh.calls().some((c) => c.startsWith("gh issue edit"))).toBe(false);
  });

  it("stdin with valid first + malformed latest block → refused, no PATCH (t_handoff_stdin_latest_block_malformed_refused)", async () => {
    const { gh, git, clock } = setup();
    // First block valid; second block opens but doesn't close.
    const note = `${MARK_O}\nfine old block\n${MARK_C}\n\n${MARK_O}\nnewer malformed\n`;
    await expect(
      runHandoff({ noteStdin: note, issue: 42, gh, git, clock }),
    ).rejects.toThrow(/marker/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });
});

// ===========================================================================
// 5. Issue arg validation
// ===========================================================================

describe("/handoff — issue arg validation", () => {
  it("issue '0' rejected (t_handoff_issue_zero)", async () => {
    const { gh, git, clock } = setup();
    await expect(
      runHandoff({ noteStdin: NOTE, issue: 0, gh, git, clock }),
    ).rejects.toThrow(/positive integer/i);
    expect(gh.calls().some((c) => c.startsWith("gh issue"))).toBe(false);
  });

  it("non-numeric issue arg rejected (TRANSFORMED — t_handoff_issue_nonnumeric)", async () => {
    // Bash test calls `bash handoff.sh '42; echo PWNED'` (raw shell payload).
    // In TS, requireIssueNumber is invoked on String(opts.issue). Programmatic
    // callers can pass any number; pass NaN to force the type-coercion path.
    const { gh, git, clock } = setup();
    await expect(
      runHandoff({
        noteStdin: NOTE,
        issue: Number.NaN,
        gh,
        git,
        clock,
      }),
    ).rejects.toThrow(/positive integer/i);
    expect(gh.calls().some((c) => c.startsWith("gh issue"))).toBe(false);
  });

  it("semicolon-payload issue arg rejected (TRANSFORMED — t_handoff_refuses_semicolon_payload)", async () => {
    // Bash payload: '42; echo PWNED'. In TS the issue arg is `number`, so the
    // CLI layer (Task 25) parses the raw string via requireIssueNumber, which
    // rejects on bare ASCII-digit allow-list. Here we exercise the same code
    // path: a non-integer numeric value forces the requireIssueNumber check.
    const { gh, git, clock } = setup();
    await expect(
      runHandoff({
        noteStdin: NOTE,
        issue: 42.5, // String(42.5) = "42.5" — fails the digit-only test
        gh,
        git,
        clock,
      }),
    ).rejects.toThrow(/positive integer|disallowed characters/i);
    expect(gh.calls().some((c) => c.startsWith("gh issue"))).toBe(false);
  });
});

// ===========================================================================
// 6. Dirty worktree (warn, not refuse)
// ===========================================================================

describe("/handoff — dirty worktree", () => {
  it("dirty worktree → warn + proceed (v2 has no push); PATCH still posted (t_handoff_dirty_warns_not_refuses)", async () => {
    const { gh, git, clock } = setup();
    git.setDirty(true);
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    const result = await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      gh,
      git,
      clock,
    });
    expect(result.created).toBe(false);
    expect(result.logs.some((l) => /uncommitted/i.test(l))).toBe(true);
    expect(gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file"))).toBe(true);
  });
});

// ===========================================================================
// 7. --link / --unlink
// ===========================================================================

describe("/handoff — link/unlink", () => {
  it("--link 103 --link 104 --link cross-repo → body has all three entries (t_handoff_link_multi)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    gh.setPrViewDefault(103, prView({ title: "deploy spec" }));
    gh.setPrViewDefault(104, prView({ title: "critic obs" }));
    gh.setPrViewDefault(59, prView({ title: "alpha-9 release", state: "MERGED" }));
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      link: ["103", "104", "momentiq-ai/dark-factory#59"],
      gh,
      git,
      clock,
    });
    const body = gh.lastEditBody()?.bodyMd ?? "";
    expect(body).toContain("**Linked work items:**");
    expect(body).toContain("- pr #103");
    expect(body).toContain("- pr #104");
    expect(body).toContain("- pr momentiq-ai/dark-factory#59");
  });

  it("--unlink 104 removes that line; others remain (t_handoff_unlink)", async () => {
    const { gh, git, clock } = setup();
    const seedEntries =
      "- pr #103 — deploy spec\n- pr #104 — critic obs\n- issue #91 — vendor degradation";
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithLinks(seedEntries) }),
    );
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      unlink: ["104"],
      gh,
      git,
      clock,
    });
    const body = gh.lastEditBody()?.bodyMd ?? "";
    expect(body).toContain("- pr #103");
    expect(body).not.toContain("- pr #104");
    expect(body).toContain("- issue #91");
  });

  it("--unlink URL canonicalizes + removes the targeted entry only (t_handoff_unlink_url_form)", async () => {
    const { gh, git, clock } = setup();
    const seedEntries =
      "- pr momentiq-ai/dark-factory-platform#103 — same-repo target\n- pr momentiq-ai/dark-factory#59 — cross-repo other";
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithLinks(seedEntries) }),
    );
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      unlink: [
        "https://github.com/momentiq-ai/dark-factory-platform/pull/103",
      ],
      gh,
      git,
      clock,
    });
    const body = gh.lastEditBody()?.bodyMd ?? "";
    expect(body).not.toContain("- pr momentiq-ai/dark-factory-platform#103");
    expect(body).toContain("- pr momentiq-ai/dark-factory#59");
  });

  it("--unlink 103 removes #103 only (no cross-repo over-match) (t_handoff_unlink_bare_number_no_cross_repo_overmatch)", async () => {
    const { gh, git, clock } = setup();
    const seedEntries =
      "- pr #103 — same-repo target\n- pr momentiq-ai/dark-factory#103 — cross-repo with SAME number";
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithLinks(seedEntries) }),
    );
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      unlink: ["103"],
      gh,
      git,
      clock,
    });
    const body = gh.lastEditBody()?.bodyMd ?? "";
    // Extract in-marker block.
    const openIdx = body.indexOf(MARK_O);
    const closeIdx = body.indexOf(MARK_C);
    const inblock = openIdx >= 0 && closeIdx > openIdx
      ? body.slice(openIdx, closeIdx)
      : "";
    expect(inblock).not.toContain("- pr #103 — same-repo target");
    expect(inblock).toContain("- pr momentiq-ai/dark-factory#103");
  });

  it("--link to handoff-labeled issue refused with no-link-cycles message (t_handoff_link_handoff_refused)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    // Make PR view fail so the link resolver falls through to issue lookup.
    gh.setAllPrViewsThrow(new Error("not a PR"));
    // The issue lookup (for link target) returns a handoff-labeled issue.
    // Both slot 1 (the handoff target's own view) and slot 2 (issue ref lookup)
    // hit the same setIssueViewDefault, so the link target picks up the
    // handoff label by default — but we have to be careful: slot 1 is the
    // primary issue (42) which we want labelled handoff anyway. The link
    // resolver calls issueView on the OTHER number (999); both go through
    // the same default.
    await expect(
      runHandoff({
        noteStdin: NOTE,
        issue: 42,
        link: ["issue:999"],
        gh,
        git,
        clock,
      }),
    ).rejects.toThrow(/no link-cycles/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("--link URL with ?query=string accepted, parsed, linked (t_handoff_link_url_with_query_string_allowed)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    gh.setPrViewDefault(103, prView({ title: "deploy" }));
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      link: [
        "https://github.com/momentiq-ai/dark-factory-platform/pull/103?tab=files",
      ],
      gh,
      git,
      clock,
    });
    const body = gh.lastEditBody()?.bodyMd ?? "";
    expect(gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file"))).toBe(true);
    expect(body).toContain("- pr momentiq-ai/dark-factory-platform#103");
  });

  it("--link project URL refused with explicit 'deferred to Phase 12.2' message (t_handoff_link_project_url_deferred)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    await expect(
      runHandoff({
        noteStdin: NOTE,
        issue: 42,
        link: ["https://github.com/orgs/momentiq-ai/projects/3"],
        gh,
        git,
        clock,
      }),
    ).rejects.toThrow(/deferred to phase 12\.2|project-item linkage/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("--link with tab-in-title preserved (t_handoff_link_title_with_tab_preserved)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    // Tab-bearing title (literal \t).
    gh.setPrViewDefault(503, prView({ title: "title with\tembedded tab" }));
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      link: ["503"],
      gh,
      git,
      clock,
    });
    const body = gh.lastEditBody()?.bodyMd ?? "";
    expect(body).toContain("- pr #503");
    expect(body).toContain("title with\tembedded tab");
  });

  it("--link with secret-shaped title refused, no PATCH, no value echo (t_handoff_link_secret_in_title_refused)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    const akia = "AKIAIOSFODNN7EXAMPLE";
    gh.setPrViewDefault(
      303,
      prView({ title: `leftover debug ${akia} in title` }),
    );
    let msg = "";
    try {
      await runHandoff({
        noteStdin: NOTE,
        issue: 42,
        link: ["303"],
        gh,
        git,
        clock,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/secret-shaped content/i);
    expect(msg).not.toContain(akia);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("in-marker section contains canonical, not stale outside-marker entries (t_handoff_link_parse_scoped_to_markers)", async () => {
    const { gh, git, clock } = setup();
    // Outside-marker stale section + inside-marker canonical section.
    const body =
      "**Linked work items:**\n- pr #999 — STALE (outside markers)\n\n" +
      `${MARK_O}\n_Updated: 2026-05-29_\n\n` +
      "**Linked work items:**\n- pr #103 — canonical inside-marker\n\n" +
      `why: prior\n${MARK_C}`;
    gh.setIssueViewDefault(
      issueView({ number: 42, body }),
    );
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      gh,
      git,
      clock,
    });
    const newBody = gh.lastEditBody()?.bodyMd ?? "";
    // Extract the in-marker block from the final body.
    const openIdx = newBody.indexOf(MARK_O);
    const closeIdx = newBody.indexOf(MARK_C);
    const inblock = openIdx >= 0 && closeIdx > openIdx
      ? newBody.slice(openIdx, closeIdx)
      : "";
    expect(inblock).toContain("- pr #103");
    expect(inblock).not.toContain("- pr #999");
  });

  it("split-args case: issue 42 + --link 103 → body PATCH contains '- pr #103' (t_handoff_command_passes_split_args)", async () => {
    // Bash exercises `read -r -a` tokenization of "42 --link 103". In TS,
    // argv is OS-split — verify the verb-level behavior with the same end
    // state: issue 42 + link 103 → PATCH with the linked entry.
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    gh.setPrViewDefault(103, prView({ title: "deploy" }));
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      link: ["103"],
      gh,
      git,
      clock,
    });
    const body = gh.lastEditBody()?.bodyMd ?? "";
    expect(gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file"))).toBe(true);
    expect(body).toContain("- pr #103");
  });
});

// ===========================================================================
// 8. Auto-link single PR
// ===========================================================================

describe("/handoff — auto-link single PR", () => {
  it("no-arg + single matching open PR → auto-linked in created issue body (t_handoff_auto_link_single_pr)", async () => {
    const { gh, git, clock } = setup();
    git.setBranch("feature/x");
    gh.setIssueListDefault([]);
    gh.setPrListByHeadDefault([{ number: 303, title: "my feature" }]);
    gh.setIssueCreateDefault({
      number: 405,
      url: "https://github.com/o/r/issues/405",
    });
    const result = await runHandoff({ noteStdin: NOTE, gh, git, clock });
    expect(result.created).toBe(true);
    const createBody = gh.lastCreateBody()?.bodyMd ?? "";
    expect(gh.calls().some((c) => c.startsWith("gh issue create"))).toBe(true);
    expect(createBody).toContain("- pr #303");
  });
});

// ===========================================================================
// 9. Pre-PATCH drift detection
// ===========================================================================

describe("/handoff — pre-PATCH drift detection", () => {
  it("pre-PATCH state drift (concurrent /accept closed it) → abort, no PATCH (t_handoff_pre_patch_state_drift_detected)", async () => {
    const { gh, git, clock } = setup();
    // Slot 1 (validate): OPEN. Slot 2 (pre-PATCH re-fetch): CLOSED.
    gh.setIssueViewSlot(
      1,
      issueView({ number: 42, body: bodyWithBlock(), state: "OPEN" }),
    );
    gh.setIssueViewSlot(
      2,
      issueView({ number: 42, body: bodyWithBlock(), state: "CLOSED" }),
    );
    await expect(
      runHandoff({ noteStdin: NOTE, issue: 42, gh, git, clock }),
    ).rejects.toThrow(/state is now CLOSED/);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("pre-PATCH assignee drift (concurrent /accept claimed it) → abort, no PATCH (t_handoff_pre_patch_assignee_drift_detected)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewSlot(
      1,
      issueView({
        number: 42,
        body: bodyWithBlock(),
        assignees: [],
      }),
    );
    gh.setIssueViewSlot(
      2,
      issueView({
        number: 42,
        body: bodyWithBlock(),
        assignees: [{ login: "other" }],
      }),
    );
    await expect(
      runHandoff({ noteStdin: NOTE, issue: 42, gh, git, clock }),
    ).rejects.toThrow(/now assigned to @other/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });

  it("pre-PATCH body drift detected → loud warn, NO PATCH (t_handoff_body_drift_detected)", async () => {
    const { gh, git, clock } = setup();
    // Slot 1 (validate): existing body has no markers (acceptable as empty
    // shell only if labels are empty). Bash test uses no-label here implicitly
    // — the body is "original body without markers", LABELS default to "handoff".
    // With handoff label + non-empty body, the explicit-issue path goes
    // through to PATCH phase, fetches body via slot 1, then pre-PATCH slot 2
    // returns DRIFTED body. The verb compares body and aborts.
    gh.setIssueViewSlot(
      1,
      issueView({ number: 42, body: "original body without markers" }),
    );
    gh.setIssueViewSlot(
      2,
      issueView({
        number: 42,
        body: "DRIFTED body — concurrent writer",
      }),
    );
    await expect(
      runHandoff({ noteStdin: NOTE, issue: 42, gh, git, clock }),
    ).rejects.toThrow(/body changed/i);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
    ).toBe(false);
  });
});

// ===========================================================================
// 10. Create-title scrub
// ===========================================================================

describe("/handoff — create-title scrub", () => {
  it("branch-derived title scrubbed → neutral title sent to gh, secret-shaped name not published (t_handoff_create_title_scrub)", async () => {
    const { gh, git, clock } = setup();
    // AWS-access-key-shaped branch (matches AKIA[0-9A-Z]{16} in SECRET_PATTERNS).
    git.setBranch("feature/AKIAIOSFODNN7EXAMPLE-leak");
    gh.setIssueListDefault([]);
    gh.setPrListByHeadDefault([]);
    gh.setIssueCreateDefault({
      number: 999,
      url: "https://github.com/o/r/issues/999",
    });
    const result = await runHandoff({ noteStdin: NOTE, gh, git, clock });
    const title = gh.lastCreateBody()?.title ?? "";
    expect(title).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.logs.some((l) => /branch name matched the secret-shaped pattern/i.test(l))).toBe(true);
  });
});

// ===========================================================================
// 11. Argv hygiene (TRANSFORMED)
// ===========================================================================

describe("/handoff — argv hygiene (TRANSFORMED)", () => {
  // The bash tests invoke the script with raw shell-metachar payloads via
  // $ARGUMENTS. In TS the CLI's argv arrives pre-split, so the semantic
  // concern (allow-list rejection BEFORE any gh mutation) is preserved
  // by requireIssueNumber rejecting non-positive integers.
  //
  // We pass the literal payload bytes via a programmatic-caller path that
  // exercises the same validator. Since `opts.issue` is typed `number`,
  // we use `Number.NaN` / fractional values to reach the same rejection
  // branch as the bash allow-list backstop. The non-integer-bytes coverage
  // is provided by the args.ts unit tests against the raw payloads.

  it("semicolon payload (TRANSFORMED — t_handoff_refuses_semicolon_payload)", async () => {
    // Bash payload: '42; echo PWNED'. TS: requireIssueNumber rejects when the
    // string form is not bare ASCII digits. Use NaN to reach the same branch.
    const { gh, git, clock } = setup();
    await expect(
      runHandoff({
        noteStdin: NOTE,
        issue: Number.NaN,
        gh,
        git,
        clock,
      }),
    ).rejects.toThrow(/positive integer|disallowed characters/i);
    expect(gh.calls().some((c) => c.startsWith("gh issue"))).toBe(false);
  });

  it("command-substitution payload (TRANSFORMED — t_handoff_refuses_command_sub_payload)", async () => {
    // Bash payload: '$(echo PWNED)'. TS reaches the validator via NaN.
    const { gh, git, clock } = setup();
    await expect(
      runHandoff({
        noteStdin: NOTE,
        issue: Number.NaN,
        gh,
        git,
        clock,
      }),
    ).rejects.toThrow(/positive integer|disallowed characters/i);
    expect(gh.calls().some((c) => c.startsWith("gh issue"))).toBe(false);
  });

  it("redirect payload (TRANSFORMED — t_handoff_refuses_redirect_payload)", async () => {
    // Bash payload: '42 > /tmp/pwn'. TS reaches the validator via fractional.
    const { gh, git, clock } = setup();
    await expect(
      runHandoff({
        noteStdin: NOTE,
        issue: 42.5,
        gh,
        git,
        clock,
      }),
    ).rejects.toThrow(/positive integer|disallowed characters/i);
    expect(gh.calls().some((c) => c.startsWith("gh issue"))).toBe(false);
  });
});

// ===========================================================================
// 12. Misc / idempotency
// ===========================================================================

// ===========================================================================
// 13. Auto-link skip cases
// ===========================================================================

describe("/handoff — auto-link skip cases", () => {
  it("no-arg + multi-PR for branch → no auto-link (only single-PR case auto-links)", async () => {
    const { gh, git, clock } = setup();
    git.setBranch("feature/x");
    gh.setIssueListDefault([]);
    // Multiple PRs match — auto-link should NOT fire.
    gh.setPrListByHeadDefault([
      { number: 303, title: "first" },
      { number: 304, title: "second" },
    ]);
    gh.setIssueCreateDefault({
      number: 800,
      url: "https://github.com/o/r/issues/800",
    });
    await runHandoff({ noteStdin: NOTE, gh, git, clock });
    const createBody = gh.lastCreateBody()?.bodyMd ?? "";
    expect(createBody).not.toContain("- pr #303");
    expect(createBody).not.toContain("- pr #304");
    // Section still present (empty).
    expect(createBody).toContain("_None linked._");
  });

  it("no-arg + branch is 'main' → no auto-link (branch guard)", async () => {
    const { gh, git, clock } = setup();
    git.setBranch("main");
    gh.setIssueListDefault([]);
    // prListByHead would never be queried for main; if it is, we'd see []
    // and just skip — defensive.
    gh.setPrListByHeadDefault([{ number: 999, title: "should not be linked" }]);
    gh.setIssueCreateDefault({
      number: 801,
      url: "https://github.com/o/r/issues/801",
    });
    await runHandoff({ noteStdin: NOTE, gh, git, clock });
    const createBody = gh.lastCreateBody()?.bodyMd ?? "";
    expect(createBody).not.toContain("- pr #999");
    expect(gh.calls().some((c) => c.startsWith("gh pr list --head main"))).toBe(false);
  });

  it("no-arg + --link present → auto-link is suppressed (explicit --link wins)", async () => {
    const { gh, git, clock } = setup();
    git.setBranch("feature/x");
    gh.setIssueListDefault([]);
    gh.setPrListByHeadDefault([{ number: 303, title: "would auto-link" }]);
    gh.setPrViewDefault(104, prView({ title: "explicit link" }));
    gh.setIssueCreateDefault({
      number: 802,
      url: "https://github.com/o/r/issues/802",
    });
    await runHandoff({
      noteStdin: NOTE,
      link: ["104"],
      gh,
      git,
      clock,
    });
    const createBody = gh.lastCreateBody()?.bodyMd ?? "";
    // Only the explicit link appears; auto-link is suppressed.
    expect(createBody).toContain("- pr #104");
    expect(createBody).not.toContain("- pr #303");
    expect(gh.calls().some((c) => c.startsWith("gh pr list --head"))).toBe(false);
  });
});

// ===========================================================================
// 14. gh-call sequence: slot 1 vs slot 2 issueView seam
// ===========================================================================

describe("/handoff — gh-call sequence (slot 1 vs slot 2 issueView)", () => {
  it("PATCH path calls issueView twice: slot 1 (validate) then slot 2 (pre-PATCH)", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      gh,
      git,
      clock,
    });
    // Both slot 1 and slot 2 calls to issueView 42 must appear.
    const slot1 = gh.calls().filter((c) => c.includes("gh issue view 42") && c.includes("slot 1"));
    const slot2 = gh.calls().filter((c) => c.includes("gh issue view 42") && c.includes("slot 2"));
    expect(slot1.length).toBe(1);
    expect(slot2.length).toBe(1);
    // And the order is slot 1 first, then slot 2 (then edit).
    const order = gh.calls();
    const slot1Idx = order.findIndex((c) => c.includes("gh issue view 42") && c.includes("slot 1"));
    const slot2Idx = order.findIndex((c) => c.includes("gh issue view 42") && c.includes("slot 2"));
    const editIdx = order.findIndex((c) => c.startsWith("gh issue edit 42 --body-file"));
    expect(slot1Idx).toBeGreaterThanOrEqual(0);
    expect(slot2Idx).toBeGreaterThan(slot1Idx);
    expect(editIdx).toBeGreaterThan(slot2Idx);
  });

  it("PATCH path also adds label + unassigns @me after edit", async () => {
    const { gh, git, clock } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock() }),
    );
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      gh,
      git,
      clock,
    });
    const order = gh.calls();
    const editIdx = order.findIndex((c) => c.startsWith("gh issue edit 42 --body-file"));
    const addLabelIdx = order.findIndex((c) => c === "gh issue edit 42 --add-label handoff");
    const unassignIdx = order.findIndex((c) => c === "gh issue edit 42 --remove-assignee @me");
    expect(editIdx).toBeGreaterThan(-1);
    expect(addLabelIdx).toBeGreaterThan(editIdx);
    expect(unassignIdx).toBeGreaterThan(addLabelIdx);
  });
});

describe("/handoff — idempotency", () => {
  it("two runs on same issue with same note → bodies byte-identical modulo _Updated:_ line (t_handoff_idempotent)", async () => {
    // Run 1: empty starting body → splice creates the first block.
    const { gh: gh1, git, clock } = setup();
    gh1.setIssueViewDefault(issueView({ number: 42, body: "" }));
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      gh: gh1,
      git,
      clock,
    });
    const body1 = gh1.lastEditBody()?.bodyMd ?? "";

    // Run 2: starting body is run-1's output → splice replaces it.
    const gh2 = new FakeGhClient();
    gh2.setIssueViewDefault(issueView({ number: 42, body: body1 }));
    await runHandoff({
      noteStdin: NOTE,
      issue: 42,
      gh: gh2,
      git,
      clock,
    });
    const body2 = gh2.lastEditBody()?.bodyMd ?? "";

    // Filter out _Updated:_ lines from both bodies and normalize trailing
    // whitespace. The bash test does diff <(printf '%s' ... | grep -v) which
    // strips the trailing newline difference between the no-markers-append
    // path (run 1) and the markers-present-splice path (run 2 — guarantees
    // trailing \n per spliceAgentContextBlock's contract).
    const filter = (s: string): string =>
      s.split("\n").filter((l) => !l.startsWith("_Updated:")).join("\n").replace(/\n+$/, "");
    expect(filter(body1)).toBe(filter(body2));
  });
});
