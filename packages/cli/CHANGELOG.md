# Changelog

## [2.7.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.6.0...dark-factory-cli-v2.7.0) (2026-06-17)


### Features

* **critic:** fail loud on shallow-clone boundary + codex char preflight ([#182](https://github.com/momentiq-ai/dark-factory/issues/182)/[#181](https://github.com/momentiq-ai/dark-factory/issues/181)) ([#203](https://github.com/momentiq-ai/dark-factory/issues/203)) ([e58fe1a](https://github.com/momentiq-ai/dark-factory/commit/e58fe1a37720b003a678caa94677111c94f70062))

## [2.6.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.5.0...dark-factory-cli-v2.6.0) (2026-06-12)


### Features

* **cli:** graduate verification-route runner to `df verify` + enforce diffHash content-binding ([#195](https://github.com/momentiq-ai/dark-factory/issues/195)) ([18a7990](https://github.com/momentiq-ai/dark-factory/commit/18a79901150f8b7143382cab6ee1b5fc7e5a7e77)), closes [#192](https://github.com/momentiq-ai/dark-factory/issues/192) [#194](https://github.com/momentiq-ai/dark-factory/issues/194)
* **skills:** graduate the `verify` skill + reusable Playwright (UI) route producer ([#196](https://github.com/momentiq-ai/dark-factory/issues/196)) ([92ba7f6](https://github.com/momentiq-ai/dark-factory/commit/92ba7f6941af710a7210b06d182b9b25fcd564c6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @momentiq/dark-factory-schemas bumped from 0.7.0 to 0.8.0

## [2.5.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.4.0...dark-factory-cli-v2.5.0) (2026-06-10)


### Features

* **handoff:** refuse no-arg link-set mismatch + stale notes ([#319](https://github.com/momentiq-ai/dark-factory/issues/319) Fix B/C) ([#179](https://github.com/momentiq-ai/dark-factory/issues/179)) ([055a07c](https://github.com/momentiq-ai/dark-factory/commit/055a07c3a062735cf9e6b73fe61ec62c62a37682))

## [2.4.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.3.0...dark-factory-cli-v2.4.0) (2026-06-08)


### Features

* **gate-core:** evidence-gated validation routes — schema + additive planner + route-runner + diffHash binding — Cycle 21 ([#187](https://github.com/momentiq-ai/dark-factory/issues/187)) ([1623bd5](https://github.com/momentiq-ai/dark-factory/commit/1623bd53eb56cd5cc5e202df415e97a7343b6de2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @momentiq/dark-factory-schemas bumped from 0.6.1 to 0.7.0

## [2.3.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.2.4...dark-factory-cli-v2.3.0) (2026-06-08)


### Features

* **adapters:** add minimax-direct-sdk adapter — MiniMax M3 via OpenRouter — Cycle 20 ([#159](https://github.com/momentiq-ai/dark-factory/issues/159)) ([a2b242d](https://github.com/momentiq-ai/dark-factory/commit/a2b242d3b19b2bcb2ce9e0bd6489aa90f96390fb))


### Bug Fixes

* **adapters:** graceful context-window degrade for gemini + grok ([#169](https://github.com/momentiq-ai/dark-factory/issues/169)) ([#177](https://github.com/momentiq-ai/dark-factory/issues/177)) ([ea0650e](https://github.com/momentiq-ai/dark-factory/commit/ea0650ed2d68ede35d2b0ef6d24fc8952cda4ff1))
* **cli:** unref'd force-exit backstop so a leaked SDK handle can't hang the CLI past the CI clamp ([#167](https://github.com/momentiq-ai/dark-factory/issues/167)) ([#171](https://github.com/momentiq-ai/dark-factory/issues/171)) ([1da22ed](https://github.com/momentiq-ai/dark-factory/commit/1da22ed31e12d6c1e120f7db6691d61edf2e3c56))
* **critic:** wire profile selection into `df critic` so codex auth pins apply on CI ([#170](https://github.com/momentiq-ai/dark-factory/issues/170)) ([#178](https://github.com/momentiq-ai/dark-factory/issues/178)) ([7004558](https://github.com/momentiq-ai/dark-factory/commit/70045584b9788f507ab87ed232242f30e4c20a26))

## [2.2.4](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.2.3...dark-factory-cli-v2.2.4) (2026-06-06)


### Bug Fixes

* **onboard:** multi-turn corrective replay for Phase B (closes [#158](https://github.com/momentiq-ai/dark-factory/issues/158)) ([#160](https://github.com/momentiq-ai/dark-factory/issues/160)) ([d3cb91c](https://github.com/momentiq-ai/dark-factory/commit/d3cb91cd2d32ce20477153a2c8c0a3eb933d6eb4))

## [2.2.3](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.2.2...dark-factory-cli-v2.2.3) (2026-06-06)


### Bug Fixes

* **onboard:** switch Phase B to messages.stream (closes [#147](https://github.com/momentiq-ai/dark-factory/issues/147)) ([73f23de](https://github.com/momentiq-ai/dark-factory/commit/73f23de2389f7ebf174aecb1cd579720668c9d53))
* **onboard:** switch Phase B to messages.stream (closes [#147](https://github.com/momentiq-ai/dark-factory/issues/147)) ([5da0836](https://github.com/momentiq-ai/dark-factory/commit/5da083646f47d180d7a3c79dd24d6aa7d3e3dfea))

## [2.2.2](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.2.1...dark-factory-cli-v2.2.2) (2026-06-06)


### Bug Fixes

* **adapters/codex-sdk:** narrow [#109](https://github.com/momentiq-ai/dark-factory/issues/109) bwrap detection — filter findings, don't discard the run (closes [#148](https://github.com/momentiq-ai/dark-factory/issues/148)) ([#149](https://github.com/momentiq-ai/dark-factory/issues/149)) ([b04468a](https://github.com/momentiq-ai/dark-factory/commit/b04468a8fe5e8393714c53794c204c609a9d50cb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @momentiq/dark-factory-schemas bumped from 0.6.0 to 0.6.1

## [2.2.1](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.2.0...dark-factory-cli-v2.2.1) (2026-06-06)


### Bug Fixes

* **onboard:** aggregate decisions from ALL lockfiles — closes [#137](https://github.com/momentiq-ai/dark-factory/issues/137) ([#142](https://github.com/momentiq-ai/dark-factory/issues/142)) ([ecc83a0](https://github.com/momentiq-ai/dark-factory/commit/ecc83a09454fb7c2092954b3c6d43fcbd461be4b))
* **onboard:** seeder donor fallback flips metric 4 on sage3c — closes [#138](https://github.com/momentiq-ai/dark-factory/issues/138) ([#143](https://github.com/momentiq-ai/dark-factory/issues/143)) ([87dbbd1](https://github.com/momentiq-ai/dark-factory/commit/87dbbd1729d57ea325b0304d6185a0e1ef12655a))
* **onboard:** template-loader cap no longer blocks sage-blueprint walk — closes [#140](https://github.com/momentiq-ai/dark-factory/issues/140) ([#141](https://github.com/momentiq-ai/dark-factory/issues/141)) ([b86e0d3](https://github.com/momentiq-ai/dark-factory/commit/b86e0d3fb78e41f02115abef3532d8e0a3d382b5))
* **onboard:** unblock Phase B LLM call — schema + model + max_tokens + stop-reason diag ([#146](https://github.com/momentiq-ai/dark-factory/issues/146)) ([47ae384](https://github.com/momentiq-ai/dark-factory/commit/47ae3847a4e70dff1d335e538dba8cb3e34281a0))

## [2.2.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.1.0...dark-factory-cli-v2.2.0) (2026-06-06)


### Features

* **doctor:** checkAgentContextSet() — agent-context-set validation — cycle 15 Phase C ([7b68611](https://github.com/momentiq-ai/dark-factory/commit/7b68611900bb093719847410d97c8c6fb522bd1a))
* **mcp:** df_onboard tool (cycle 15 Phase C exit criterion) ([5d79edd](https://github.com/momentiq-ai/dark-factory/commit/5d79eddb73c92eea7fe9201c7f9c3d4db8d4b098))
* **onboard:** ADR seeder + Seeder interface stub — cycle 15 Phase C ([fcfd049](https://github.com/momentiq-ai/dark-factory/commit/fcfd0490ca99bfad3f3cce9bc8bef2d5c65adce1))
* **onboard:** applyPlan dispatcher (dry-run + apply, partial-failure semantics) — cycle 15 Phase B ([4b1e341](https://github.com/momentiq-ai/dark-factory/commit/4b1e341b3684cdfc0174ae76f4e0fa969a5af816))
* **onboard:** CLAUDE.md/AGENTS.md merge handler — cycle 15 Phase B ([4b83166](https://github.com/momentiq-ai/dark-factory/commit/4b83166095ace9e8e6e3268ac11addb82dd4322f))
* **onboard:** CLI flag wire-up for Phase B + autoProfile module — cycle 15 Phase B ([a606ad1](https://github.com/momentiq-ai/dark-factory/commit/a606ad1075e98d5b49a76304e4cbdf424a595a8e))
* **onboard:** cycle-1 bootstrap doc seeder — cycle 15 Phase C ([5fed010](https://github.com/momentiq-ai/dark-factory/commit/5fed010cf735b3ceb7ddb65f5e2ad6290086ec73))
* **onboard:** dry-run renderer (colorized unified diff) — cycle 15 Phase B ([d36e64a](https://github.com/momentiq-ai/dark-factory/commit/d36e64a52fd9f82132e246f0e5a60a4f5fd44f38))
* **onboard:** emit writer — cycle 15 Phase B ([7029ab3](https://github.com/momentiq-ai/dark-factory/commit/7029ab3fcb37d9a53282decff7f2366176044292))
* **onboard:** generatePlan() — Stage B LLM+Zod orchestrator — cycle 15 Phase B ([a46e802](https://github.com/momentiq-ai/dark-factory/commit/a46e802879f72536df0cdf89b3d2ab76ca73f53f))
* **onboard:** LLM client wrapper (Anthropic tool-use, one-retry) — cycle 15 Phase B ([ae80e26](https://github.com/momentiq-ai/dark-factory/commit/ae80e2664e74f16ac0967b690d44b5cc48d7b29b))
* **onboard:** merge Phase B + Phase C into one ScaffoldPlan in cmdOnboard — cycle 15 Phase C ([83950af](https://github.com/momentiq-ai/dark-factory/commit/83950af5f28471cc28a050277ae03abe7c2ad5a4))
* **onboard:** Phase B scaffold generation (--dry-run/--apply/--pr) — cycle 15 Phase B (consumer momentiq-ai/dark-factory-platform[#21](https://github.com/momentiq-ai/dark-factory/issues/21)) ([d5e47c3](https://github.com/momentiq-ai/dark-factory/commit/d5e47c33cd42b1355bcde91ca1d0e0875a24195d))
* **onboard:** Phase C docs-as-code seeders + sage3c reproduction harness + MCP surface — cycle 15 Phase C (consumer momentiq-ai/dark-factory-platform[#21](https://github.com/momentiq-ai/dark-factory/issues/21)) ([82fa5ea](https://github.com/momentiq-ai/dark-factory/commit/82fa5eacc6c93d85aa59a05614dc864b70c8f4a8))
* **onboard:** pr-writer (gh-auth + branch + apply + commit + pr create) — cycle 15 Phase B ([92dce84](https://github.com/momentiq-ai/dark-factory/commit/92dce84ee1ad7a56c8d764e005b12351578f0fb7))
* **onboard:** runbook seeder — cycle 15 Phase C ([f0f3b6d](https://github.com/momentiq-ai/dark-factory/commit/f0f3b6de3b70a21dd948aa5d769042e65ae09a0f))
* **onboard:** ScaffoldPlan Zod schema + parseTemplateRef foundation + tests — cycle 15 Phase B ([995dd6a](https://github.com/momentiq-ai/dark-factory/commit/995dd6ae58bef2804976109a15f323afd2a98b68))
* **onboard:** seeder orchestrator + ALL_SEEDERS export — cycle 15 Phase C ([786cd8c](https://github.com/momentiq-ai/dark-factory/commit/786cd8cb1eda39e4e91bbd082bc7190f6c22820f))
* **onboard:** skip writer — cycle 15 Phase B ([f3743dd](https://github.com/momentiq-ai/dark-factory/commit/f3743ddd755ee3ff5da942795e1fe2ad14aeed81))
* **onboard:** Stage B scaffold prompt asset + renderer — cycle 15 Phase B ([b4c5895](https://github.com/momentiq-ai/dark-factory/commit/b4c5895356b8870af55e0af6aab602c6ab332a50))
* **onboard:** template-loader (gh:+file://, sha-keyed cache, walk filter) — cycle 15 Phase B ([d013e2a](https://github.com/momentiq-ai/dark-factory/commit/d013e2a20dead50781b4748c07e7cc4c92c0aa56))

## [2.1.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v2.0.0...dark-factory-cli-v2.1.0) (2026-06-04)


### Features

* **onboard:** analyze() orchestrator + schema validation — cycle 15 Phase A ([0482a61](https://github.com/momentiq-ai/dark-factory/commit/0482a6162f9d59786791fbcef005102d806ab400))
* **onboard:** Analyzer interface + runAnalyzers orchestrator helper — cycle 15 Phase A ([dab07c0](https://github.com/momentiq-ai/dark-factory/commit/dab07c0e2a900f52ddccb9e4c84d92a120efa9c7))
* **onboard:** CI analyzer (workflow parse + deploy-story heuristic) — cycle 15 Phase A ([add221b](https://github.com/momentiq-ai/dark-factory/commit/add221bb724c1793387a656a2dbdb07bd8151184))
* **onboard:** df onboard --analysis-only --json CLI command — cycle 15 Phase A ([883ec73](https://github.com/momentiq-ai/dark-factory/commit/883ec73007970f2de6d0a997c3f4beb52542d74f))
* **onboard:** docs + DF-gate-presence analyzer — cycle 15 Phase A ([039eb21](https://github.com/momentiq-ai/dark-factory/commit/039eb210ac2932564c4aeb88fdfc9044febfe761))
* **onboard:** git analyzer (canonical name, conventions, default branch) — cycle 15 Phase A ([666be66](https://github.com/momentiq-ai/dark-factory/commit/666be664009f10fa5ab7146179815b1450d440e8))
* **onboard:** lockfile analyzer (decision-surface heuristics) — cycle 15 Phase A ([4a27cb1](https://github.com/momentiq-ai/dark-factory/commit/4a27cb1cc4e3b76fd089574f4750372fc0fe3650))
* **onboard:** manifest analyzer (9 stacks) — cycle 15 Phase A ([d767715](https://github.com/momentiq-ai/dark-factory/commit/d767715e556c377b3e4646c801be7c6b7f2b6707))
* **onboard:** Phase A repo analyzer (df onboard --analysis-only --json) — cycle 15 Phase A (consumer momentiq-ai/dark-factory-platform[#21](https://github.com/momentiq-ai/dark-factory/issues/21)) ([70b1b17](https://github.com/momentiq-ai/dark-factory/commit/70b1b171afe95057bf5075ddb56fabc6d35ddaad))
* **onboard:** RepoAnalysis Zod schema + tests — cycle 15 Phase A ([d3f31bd](https://github.com/momentiq-ai/dark-factory/commit/d3f31bdc7ff6cd5a7a3b6a67a625fbd661294421))
* **onboard:** tree analyzer (dir classify, lang breakdown, services discovery) — cycle 15 Phase A ([ebb4f8c](https://github.com/momentiq-ai/dark-factory/commit/ebb4f8c220df2b613499e48d3e780dcdf0688cb7))


### Bug Fixes

* **cycle-doc-validator:** accept both docs/cycles and docs/roadmap/cycles layouts ([#133](https://github.com/momentiq-ai/dark-factory/issues/133)) ([31c3394](https://github.com/momentiq-ai/dark-factory/commit/31c33940f369894027cd3cb6d7ed07ed24cef52d))

## [2.0.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v1.2.0...dark-factory-cli-v2.0.0) (2026-06-03)


### ⚠ BREAKING CHANGES

* **cycle12.2:** Cycle 8 v1 handoff (PR-arg signatures, 894-LOC monolith, function-runner seams) deleted wholesale. Replaced by the Cycle 12 v2 Issue-anchored surface built on the GhClient/GitClient object ports.

### Features

* **331.1-B:** extract Critic Orchestrator + Policy Engine + Trusted-Surface Rebind into packages/cli/ ([#1](https://github.com/momentiq-ai/dark-factory/issues/1)) ([4314365](https://github.com/momentiq-ai/dark-factory/commit/4314365e69760356be06ad9948ee97aaa611b55f))
* **adapters/codex-sdk:** expose sandbox_mode for trusted-container contexts ([#98](https://github.com/momentiq-ai/dark-factory/issues/98)) ([ada1ab2](https://github.com/momentiq-ai/dark-factory/commit/ada1ab2982670734bb7e5e2f6c9fb078c43482bc)), closes [#68](https://github.com/momentiq-ai/dark-factory/issues/68)
* **adapters:** static-schema-lint deterministic adapter — implements consumer dark-factory-platform[#107](https://github.com/momentiq-ai/dark-factory/issues/107) ([#116](https://github.com/momentiq-ai/dark-factory/issues/116)) ([29cc83c](https://github.com/momentiq-ai/dark-factory/commit/29cc83c1c820de915a9f50ec45c41e87e4e8d927))
* **aggregator:** self-consistency probe + requireCorroborationFor policy — implements consumer dark-factory-platform[#112](https://github.com/momentiq-ai/dark-factory/issues/112) ([#118](https://github.com/momentiq-ai/dark-factory/issues/118)) ([31345c1](https://github.com/momentiq-ai/dark-factory/commit/31345c1d60a54ce1841f573101a17f1e1dbc8447))
* **cli:** add cursor-cli adapter for subscription auth — closes [#28](https://github.com/momentiq-ai/dark-factory/issues/28) ([#52](https://github.com/momentiq-ai/dark-factory/issues/52)) ([6a205d1](https://github.com/momentiq-ai/dark-factory/commit/6a205d1f608229541960643ebf7096ca58e13d5a))
* **cli:** agent handoff protocol — df handoff/accept/rehydrate/handoffs + MCP tools/prompts — Cycle 8 Phase 8.2 ([5818387](https://github.com/momentiq-ai/dark-factory/commit/581838768bfcc6a12c7dbe4406cf4ea6bf82426e))
* **cli:** agent handoff protocol — df handoff/accept/rehydrate/handoffs + MCP tools/prompts — Cycle 8 Phase 8.2 ([c7a5a88](https://github.com/momentiq-ai/dark-factory/commit/c7a5a88a61b186a08dd94683ecd9573c4431cd6c))
* **cli:** bounded lockfile strategy for review-packet ([#104](https://github.com/momentiq-ai/dark-factory/issues/104)) ([891ff30](https://github.com/momentiq-ai/dark-factory/commit/891ff303e12324566254eb04fba84a69da6129ed)), closes [#67](https://github.com/momentiq-ai/dark-factory/issues/67)
* **cli:** df flow — surface PR Flow Assessor records — Cycle 11 Phase 11.1 ([#63](https://github.com/momentiq-ai/dark-factory/issues/63)) ([6869da1](https://github.com/momentiq-ai/dark-factory/commit/6869da18f84f631608fbd61925a57015e46ad852))
* **cli:** df mcp skeleton + initialize handshake — Cycle 5 Phase 1 step 1 ([0f087c0](https://github.com/momentiq-ai/dark-factory/commit/0f087c09d6cec325b49a09d7964b3f6759a34a0d))
* **cli:** df mcp skeleton + initialize handshake — Cycle 5 Phase 1 step 1 ([63c641c](https://github.com/momentiq-ai/dark-factory/commit/63c641cb661dd7c29e433f5796f87359806325da))
* **cli:** df_adr_list + df_adr_read MCP tools — Cycle 5 Phase 1 step 3c ([0d8dbd4](https://github.com/momentiq-ai/dark-factory/commit/0d8dbd4b4b58906b8a08f4b81fd5f2312e9a4f3b))
* **cli:** df_adr_list + df_adr_read MCP tools — Cycle 5 Phase 1 step 3c ([c8c27b8](https://github.com/momentiq-ai/dark-factory/commit/c8c27b86d3bb71dbfa57c391131e96e37b49927e))
* **cli:** df_critics_config MCP tool — Cycle 5 Phase 1 step 3d (closes step 3) ([73d2b6f](https://github.com/momentiq-ai/dark-factory/commit/73d2b6fc8a5eb59564070dcd0f47c08eb2c9bddb))
* **cli:** df_critics_config MCP tool — Cycle 5 Phase 1 step 3d (closes step 3) ([8beedd5](https://github.com/momentiq-ai/dark-factory/commit/8beedd57df88d67de35da1b403dda825c03784b0))
* **cli:** df_cycle_doc_generate + df_adr_generate via sampling — Cycle 5 Phase 1 step 8 ([58f6895](https://github.com/momentiq-ai/dark-factory/commit/58f6895358a01fb939444c084046fa45b6463485))
* **cli:** df_cycle_doc_generate + df_adr_generate via sampling — Cycle 5 Phase 1 step 8 ([ad026b0](https://github.com/momentiq-ai/dark-factory/commit/ad026b0ab4732d7801da8fb063617fb89c6d46a8))
* **cli:** df_cycle_list + df_cycle_read MCP tools — Cycle 5 Phase 1 step 3a ([63f4311](https://github.com/momentiq-ai/dark-factory/commit/63f4311d6b0050fe488777f24bc4462ddc5fc5fb))
* **cli:** df_cycle_list + df_cycle_read MCP tools — Cycle 5 Phase 1 step 3a ([761ad18](https://github.com/momentiq-ai/dark-factory/commit/761ad18e7c263c93d1c39f4394af9f01f15a2645))
* **cli:** df_doctor MCP tool — Cycle 5 Phase 1 step 2 ([153dce3](https://github.com/momentiq-ai/dark-factory/commit/153dce3c73b70132764a716b91ea9aa45bb7e238))
* **cli:** df_doctor MCP tool — Cycle 5 Phase 1 step 2 ([ea46c7e](https://github.com/momentiq-ai/dark-factory/commit/ea46c7e5e44b714816e06412d8f2d26180a7fbcb))
* **cli:** df_findings + df_show_run MCP tools — Cycle 5 Phase 1 step 3b ([c5ddb5f](https://github.com/momentiq-ai/dark-factory/commit/c5ddb5f5cc419864147d6273bf147370613b8735))
* **cli:** df_findings + df_show_run MCP tools — Cycle 5 Phase 1 step 3b ([3e0e2eb](https://github.com/momentiq-ai/dark-factory/commit/3e0e2eb9d29192938aa98deac9e7aad5eca065eb))
* **cli:** df_review + df_review_status + df_bypass MCP tools — Cycle 5 Phase 1 step 6 ([0184c4e](https://github.com/momentiq-ai/dark-factory/commit/0184c4e6b217a1bef4367eb098d87d71a79c4011))
* **cli:** df_review + df_review_status + df_bypass MCP tools — Cycle 5 Phase 1 step 6 ([2bdc9f1](https://github.com/momentiq-ai/dark-factory/commit/2bdc9f111ffb7177e8d76394986ff85f88a0b5c6))
* **cli:** df_stats + df_gate_push MCP tools — Cycle 5 Phase 1 step 5 ([791ceca](https://github.com/momentiq-ai/dark-factory/commit/791cecae21d39c41f1cf0f990cbb00cdddb30553))
* **cli:** df_stats + df_gate_push MCP tools — Cycle 5 Phase 1 step 5 ([4ecb3ec](https://github.com/momentiq-ai/dark-factory/commit/4ecb3ec605a5beeb300337507769affea936042d))
* **cli:** implement df show/status + scrub help text (closes [#55](https://github.com/momentiq-ai/dark-factory/issues/55) [#89](https://github.com/momentiq-ai/dark-factory/issues/89)) ([#101](https://github.com/momentiq-ai/dark-factory/issues/101)) ([edda2d7](https://github.com/momentiq-ai/dark-factory/commit/edda2d7d0ee116857cc735f816aeb2b08e8a1c9f))
* **cli:** MCP prompts (pure templates) — Cycle 5 Phase 1 step 7 ([0100945](https://github.com/momentiq-ai/dark-factory/commit/0100945060d6a68d2eae3af4e4fd99944bddcb1a))
* **cli:** MCP prompts (pure templates) — Cycle 5 Phase 1 step 7 ([2993a3b](https://github.com/momentiq-ai/dark-factory/commit/2993a3be8bc68fe02ee0179193b757bcd293b81a))
* **cli:** MCP resources surface — Cycle 5 Phase 1 step 4 ([8486fb0](https://github.com/momentiq-ai/dark-factory/commit/8486fb017cc105e296acd99c55fc2a26f2e33894))
* **cli:** MCP resources surface — Cycle 5 Phase 1 step 4 ([5092eaa](https://github.com/momentiq-ai/dark-factory/commit/5092eaaf27c4ba37091c9884575371be14f883cb))
* **cli:** wire elicitation for df_bypass — Cycle 5 Phase 1 step 9 ([c400e23](https://github.com/momentiq-ai/dark-factory/commit/c400e2347e6c446967d758e62423bc3b2cde98b5))
* **cli:** wire elicitation for df_bypass — Cycle 5 Phase 1 step 9 ([5c95d6a](https://github.com/momentiq-ai/dark-factory/commit/5c95d6a979cae31f2f5575b72cb375923bfc89a7))
* **cli:** wire logging/message notifications — Cycle 5 Phase 1 step 10 ([9fcbb8b](https://github.com/momentiq-ai/dark-factory/commit/9fcbb8b06258664db9864ae16d98ffb11a33351d))
* **cli:** wire logging/message notifications — Cycle 5 Phase 1 step 10 ([516e701](https://github.com/momentiq-ai/dark-factory/commit/516e701cbce94bce849b380707ffd871391c6d98))
* **critics:** consume .git/agent-reviews/_dockerbuild-evidence.json — implements consumer dark-factory-platform[#141](https://github.com/momentiq-ai/dark-factory/issues/141) upstream half ([#115](https://github.com/momentiq-ai/dark-factory/issues/115)) ([d43527e](https://github.com/momentiq-ai/dark-factory/commit/d43527e50c48f64d49191fa6d735d7d1d21b6f6c))
* **cycle12.2:** df CLI Issue-arg handoff subcommands + MCP signature change ([#69](https://github.com/momentiq-ai/dark-factory/issues/69)) ([3aec608](https://github.com/momentiq-ai/dark-factory/commit/3aec608a0573a2ce07a7a9a6e8e397c078203afb))
* **doctor:** cache-tree corruption probe (closes [#107](https://github.com/momentiq-ai/dark-factory/issues/107)) ([#110](https://github.com/momentiq-ai/dark-factory/issues/110)) ([e9e9d98](https://github.com/momentiq-ai/dark-factory/commit/e9e9d9835f8e643bad22d63d624fd61cf3919e0e))
* **doctor:** per-critic auth probe + cloud-env detection + --json — implements consumer issue dark-factory-platform[#56](https://github.com/momentiq-ai/dark-factory/issues/56) ([#114](https://github.com/momentiq-ai/dark-factory/issues/114)) ([27bce85](https://github.com/momentiq-ai/dark-factory/commit/27bce854d5f1158079a089ca2f8a80d8f911cf4f))
* **gate-push:** final-commit-only default + DF_GATE_FULL_RANGE legacy mode — implements consumer dark-factory-platform[#149](https://github.com/momentiq-ai/dark-factory/issues/149) (CLI 1.1.0) ([#117](https://github.com/momentiq-ai/dark-factory/issues/117)) ([970db7a](https://github.com/momentiq-ai/dark-factory/commit/970db7a6fbbbb53c60ef5bb6405d4f1e5341c0a2))
* **phase-c:** extract services [#4](https://github.com/momentiq-ai/dark-factory/issues/4)/[#5](https://github.com/momentiq-ai/dark-factory/issues/5)/[#7](https://github.com/momentiq-ai/dark-factory/issues/7)/[#9](https://github.com/momentiq-ai/dark-factory/issues/9) from sage3c ([#2](https://github.com/momentiq-ai/dark-factory/issues/2)) ([4d499b6](https://github.com/momentiq-ai/dark-factory/commit/4d499b6e17b6bb8cabd9e06879f3dd46618bc6d3))
* **phase-d:** extract services [#6](https://github.com/momentiq-ai/dark-factory/issues/6) (Merge Queue Admission) + [#8](https://github.com/momentiq-ai/dark-factory/issues/8) (Audit Trail) — final extraction phase ([#3](https://github.com/momentiq-ai/dark-factory/issues/3)) ([623ac93](https://github.com/momentiq-ai/dark-factory/commit/623ac93b4f4dbf9e15b4713aeab894089f882231))
* **phase-e:** reusable workflow shapes — ends chicken-and-egg ([#4](https://github.com/momentiq-ai/dark-factory/issues/4)) ([26a0a4f](https://github.com/momentiq-ai/dark-factory/commit/26a0a4fe405b20dc951b42539f420669387b2b72))
* **phase-f-local:** port hook-facing CLI subcommands — review/gate-push/doctor/gates/stats (subscription cost model) ([#9](https://github.com/momentiq-ai/dark-factory/issues/9)) ([e55495b](https://github.com/momentiq-ai/dark-factory/commit/e55495bcb5f2ef3bf55534d3c954c4284f1b3618))
* **phase-f:** dogfood — wire real critic + sentinel status-check; validate Phase E workflows end-to-end ([#5](https://github.com/momentiq-ai/dark-factory/issues/5)) ([01765a4](https://github.com/momentiq-ai/dark-factory/commit/01765a409d6e0c69bd2baccc882f74317d6794ae))
* **policy:** injectedConfigAuthoritative — honor caller-injected config when commit touches .agent-review/** (closes [#56](https://github.com/momentiq-ai/dark-factory/issues/56), refs [#57](https://github.com/momentiq-ai/dark-factory/issues/57)) ([#61](https://github.com/momentiq-ai/dark-factory/issues/61)) ([445cedb](https://github.com/momentiq-ai/dark-factory/commit/445cedbdb734f395ee3bb51ab8e76bf75d2bf6b0))
* **schemas+adapters:** add CliReviewFinding.requiresHumanJudgment LLM self-flag ([#111](https://github.com/momentiq-ai/dark-factory/issues/111)) ([7041549](https://github.com/momentiq-ai/dark-factory/commit/7041549b569798d2d31a484930a5b1c785bceb0a)), closes [#106](https://github.com/momentiq-ai/dark-factory/issues/106)
* **schemas+adapters:** per-critic token + retries telemetry — Cycle 6.3 Stage 1 ([#65](https://github.com/momentiq-ai/dark-factory/issues/65)) ([4e99467](https://github.com/momentiq-ai/dark-factory/commit/4e99467ea8d944e37fc96ec28d3b799c454b9630))
* **skills:** df skills install command + bundled chief-engineer-review/blitz skills — implements consumer dark-factory-platform[#192](https://github.com/momentiq-ai/dark-factory/issues/192) ([#119](https://github.com/momentiq-ai/dark-factory/issues/119)) ([986c47c](https://github.com/momentiq-ai/dark-factory/commit/986c47c353fdad28314130f85edcd7a82a92cd67))


### Bug Fixes

* **adapters,workflows:** A2 retry-helpers + Cursor sqlite3 prebuilt (closes [#11](https://github.com/momentiq-ai/dark-factory/issues/11)) ([#13](https://github.com/momentiq-ai/dark-factory/issues/13)) ([dc60d87](https://github.com/momentiq-ai/dark-factory/commit/dc60d8768370bc0633279d356b0e864685005ba1))
* **adapters/codex-sdk:** degrade sandbox-init failures to status:error (closes [#109](https://github.com/momentiq-ai/dark-factory/issues/109)) ([#112](https://github.com/momentiq-ai/dark-factory/issues/112)) ([ac4a168](https://github.com/momentiq-ai/dark-factory/commit/ac4a168c19e3c96d34c2b50be67a499cdc64eaa7))
* **adapters/cursor-cli:** emit status=complete + opt-out sandbox flag ([#92](https://github.com/momentiq-ai/dark-factory/issues/92)) ([aa8a326](https://github.com/momentiq-ai/dark-factory/commit/aa8a326299a0c0f72d3755e872fc0f7129fe6979)), closes [#70](https://github.com/momentiq-ai/dark-factory/issues/70) [#91](https://github.com/momentiq-ai/dark-factory/issues/91)
* **agent-critic:** upload evidence artifact + surface per-critic errors + loud degradation warning ([#19](https://github.com/momentiq-ai/dark-factory/issues/19)) ([d4fac63](https://github.com/momentiq-ai/dark-factory/commit/d4fac635876f2972128cf25a33fba8beac01e0ca)), closes [#18](https://github.com/momentiq-ai/dark-factory/issues/18)
* **cli:** add adapters barrel so ./adapters subpath export resolves ([#23](https://github.com/momentiq-ai/dark-factory/issues/23)) ([#24](https://github.com/momentiq-ai/dark-factory/issues/24)) ([0d85974](https://github.com/momentiq-ai/dark-factory/commit/0d85974cb604120067d8652c47d7a5e8927ad373))
* **cli:** don't block consumer PRs that run no critic-side quality gates ([#32](https://github.com/momentiq-ai/dark-factory/issues/32)) ([aaf6d3c](https://github.com/momentiq-ai/dark-factory/commit/aaf6d3c95aed5533a0ddc04a3c863e746d9bf8ab))
* **cli:** loud diagnostic for zero-evidence reviews + df doctor triage ([#96](https://github.com/momentiq-ai/dark-factory/issues/96)) ([3374540](https://github.com/momentiq-ai/dark-factory/commit/337454069f07085f552e093d045e4462c56ebc98)), closes [#51](https://github.com/momentiq-ai/dark-factory/issues/51)
* **cli:** SIGTERM lock release + df doctor orphan-lock sweep ([#108](https://github.com/momentiq-ai/dark-factory/issues/108)) ([ff9c55b](https://github.com/momentiq-ai/dark-factory/commit/ff9c55bd5773999f6cb3139dc0b601967d3f22bd)), closes [#105](https://github.com/momentiq-ai/dark-factory/issues/105)
* **cycle-doc-validator:** narrow plan-PR scope to docs/roadmap/cycles/cycle*.md ([#95](https://github.com/momentiq-ai/dark-factory/issues/95)) ([73a4942](https://github.com/momentiq-ai/dark-factory/commit/73a49422f992b9da76a34dccab1aa80a6dcea4f2)), closes [#25](https://github.com/momentiq-ai/dark-factory/issues/25)
* **mcp:** handoff/rehydrate prompts to v2 Issue-anchored + drop deprecation note ([#99](https://github.com/momentiq-ai/dark-factory/issues/99)) ([946f323](https://github.com/momentiq-ai/dark-factory/commit/946f323f69f9a2d53c63472ce44c345e94aa0142)), closes [#79](https://github.com/momentiq-ai/dark-factory/issues/79) [#72](https://github.com/momentiq-ai/dark-factory/issues/72)
* **observability:** default sink for self-mod-guard splits info→stdout, warn→stderr ([#97](https://github.com/momentiq-ai/dark-factory/issues/97)) ([ddfc22f](https://github.com/momentiq-ai/dark-factory/commit/ddfc22f7f611be331f68ade9e86122cdb1b19942)), closes [#57](https://github.com/momentiq-ai/dark-factory/issues/57)
* **phase-b-publish-pkg:** lazy-load vendor adapters so CLI runs under --ignore-scripts ([#8](https://github.com/momentiq-ai/dark-factory/issues/8)) ([f2d834b](https://github.com/momentiq-ai/dark-factory/commit/f2d834b2c8a9264d0b1d7ab54b58ba2420b21ce6))
* **workflows:** pr-status-check context + agent-critic timeout/leak (closes [#27](https://github.com/momentiq-ai/dark-factory/issues/27) [#29](https://github.com/momentiq-ai/dark-factory/issues/29)) ([#102](https://github.com/momentiq-ai/dark-factory/issues/102)) ([28adf90](https://github.com/momentiq-ai/dark-factory/commit/28adf908b4012283219a0b302399f9e63047d175))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @momentiq/dark-factory-schemas bumped from 0.5.0 to 0.6.0

## [1.1.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v1.0.0...dark-factory-cli-v1.1.0) (2026-06-02)


### Features

* **adapters/codex-sdk:** expose sandbox_mode for trusted-container contexts ([#98](https://github.com/momentiq-ai/dark-factory/issues/98)) ([ada1ab2](https://github.com/momentiq-ai/dark-factory/commit/ada1ab2982670734bb7e5e2f6c9fb078c43482bc)), closes [#68](https://github.com/momentiq-ai/dark-factory/issues/68)
* **cli:** bounded lockfile strategy for review-packet ([#104](https://github.com/momentiq-ai/dark-factory/issues/104)) ([891ff30](https://github.com/momentiq-ai/dark-factory/commit/891ff303e12324566254eb04fba84a69da6129ed)), closes [#67](https://github.com/momentiq-ai/dark-factory/issues/67)
* **cli:** implement df show/status + scrub help text (closes [#55](https://github.com/momentiq-ai/dark-factory/issues/55) [#89](https://github.com/momentiq-ai/dark-factory/issues/89)) ([#101](https://github.com/momentiq-ai/dark-factory/issues/101)) ([edda2d7](https://github.com/momentiq-ai/dark-factory/commit/edda2d7d0ee116857cc735f816aeb2b08e8a1c9f))
* **doctor:** cache-tree corruption probe (closes [#107](https://github.com/momentiq-ai/dark-factory/issues/107)) ([#110](https://github.com/momentiq-ai/dark-factory/issues/110)) ([e9e9d98](https://github.com/momentiq-ai/dark-factory/commit/e9e9d9835f8e643bad22d63d624fd61cf3919e0e))
* **schemas+adapters:** add CliReviewFinding.requiresHumanJudgment LLM self-flag ([#111](https://github.com/momentiq-ai/dark-factory/issues/111)) ([7041549](https://github.com/momentiq-ai/dark-factory/commit/7041549b569798d2d31a484930a5b1c785bceb0a)), closes [#106](https://github.com/momentiq-ai/dark-factory/issues/106)


### Bug Fixes

* **adapters/codex-sdk:** degrade sandbox-init failures to status:error (closes [#109](https://github.com/momentiq-ai/dark-factory/issues/109)) ([#112](https://github.com/momentiq-ai/dark-factory/issues/112)) ([ac4a168](https://github.com/momentiq-ai/dark-factory/commit/ac4a168c19e3c96d34c2b50be67a499cdc64eaa7))
* **adapters/cursor-cli:** emit status=complete + opt-out sandbox flag ([#92](https://github.com/momentiq-ai/dark-factory/issues/92)) ([aa8a326](https://github.com/momentiq-ai/dark-factory/commit/aa8a326299a0c0f72d3755e872fc0f7129fe6979)), closes [#70](https://github.com/momentiq-ai/dark-factory/issues/70) [#91](https://github.com/momentiq-ai/dark-factory/issues/91)
* **cli:** loud diagnostic for zero-evidence reviews + df doctor triage ([#96](https://github.com/momentiq-ai/dark-factory/issues/96)) ([3374540](https://github.com/momentiq-ai/dark-factory/commit/337454069f07085f552e093d045e4462c56ebc98)), closes [#51](https://github.com/momentiq-ai/dark-factory/issues/51)
* **cli:** SIGTERM lock release + df doctor orphan-lock sweep ([#108](https://github.com/momentiq-ai/dark-factory/issues/108)) ([ff9c55b](https://github.com/momentiq-ai/dark-factory/commit/ff9c55bd5773999f6cb3139dc0b601967d3f22bd)), closes [#105](https://github.com/momentiq-ai/dark-factory/issues/105)
* **cycle-doc-validator:** narrow plan-PR scope to docs/roadmap/cycles/cycle*.md ([#95](https://github.com/momentiq-ai/dark-factory/issues/95)) ([73a4942](https://github.com/momentiq-ai/dark-factory/commit/73a49422f992b9da76a34dccab1aa80a6dcea4f2)), closes [#25](https://github.com/momentiq-ai/dark-factory/issues/25)
* **mcp:** handoff/rehydrate prompts to v2 Issue-anchored + drop deprecation note ([#99](https://github.com/momentiq-ai/dark-factory/issues/99)) ([946f323](https://github.com/momentiq-ai/dark-factory/commit/946f323f69f9a2d53c63472ce44c345e94aa0142)), closes [#79](https://github.com/momentiq-ai/dark-factory/issues/79) [#72](https://github.com/momentiq-ai/dark-factory/issues/72)
* **observability:** default sink for self-mod-guard splits info→stdout, warn→stderr ([#97](https://github.com/momentiq-ai/dark-factory/issues/97)) ([ddfc22f](https://github.com/momentiq-ai/dark-factory/commit/ddfc22f7f611be331f68ade9e86122cdb1b19942)), closes [#57](https://github.com/momentiq-ai/dark-factory/issues/57)
* **workflows:** pr-status-check context + agent-critic timeout/leak (closes [#27](https://github.com/momentiq-ai/dark-factory/issues/27) [#29](https://github.com/momentiq-ai/dark-factory/issues/29)) ([#102](https://github.com/momentiq-ai/dark-factory/issues/102)) ([28adf90](https://github.com/momentiq-ai/dark-factory/commit/28adf908b4012283219a0b302399f9e63047d175))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @momentiq/dark-factory-schemas bumped from 0.3.0 to 0.4.0

## [1.0.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v0.7.0...dark-factory-cli-v1.0.0) (2026-05-31)


### ⚠ BREAKING CHANGES

* **cycle12.2:** Cycle 8 v1 handoff (PR-arg signatures, 894-LOC monolith, function-runner seams) deleted wholesale. Replaced by the Cycle 12 v2 Issue-anchored surface built on the GhClient/GitClient object ports.

### Features

* **331.1-B:** extract Critic Orchestrator + Policy Engine + Trusted-Surface Rebind into packages/cli/ ([#1](https://github.com/momentiq-ai/dark-factory/issues/1)) ([4314365](https://github.com/momentiq-ai/dark-factory/commit/4314365e69760356be06ad9948ee97aaa611b55f))
* **cli:** add cursor-cli adapter for subscription auth — closes [#28](https://github.com/momentiq-ai/dark-factory/issues/28) ([#52](https://github.com/momentiq-ai/dark-factory/issues/52)) ([6a205d1](https://github.com/momentiq-ai/dark-factory/commit/6a205d1f608229541960643ebf7096ca58e13d5a))
* **cli:** agent handoff protocol — df handoff/accept/rehydrate/handoffs + MCP tools/prompts — Cycle 8 Phase 8.2 ([5818387](https://github.com/momentiq-ai/dark-factory/commit/581838768bfcc6a12c7dbe4406cf4ea6bf82426e))
* **cli:** agent handoff protocol — df handoff/accept/rehydrate/handoffs + MCP tools/prompts — Cycle 8 Phase 8.2 ([c7a5a88](https://github.com/momentiq-ai/dark-factory/commit/c7a5a88a61b186a08dd94683ecd9573c4431cd6c))
* **cli:** df flow — surface PR Flow Assessor records — Cycle 11 Phase 11.1 ([#63](https://github.com/momentiq-ai/dark-factory/issues/63)) ([6869da1](https://github.com/momentiq-ai/dark-factory/commit/6869da18f84f631608fbd61925a57015e46ad852))
* **cli:** df mcp skeleton + initialize handshake — Cycle 5 Phase 1 step 1 ([0f087c0](https://github.com/momentiq-ai/dark-factory/commit/0f087c09d6cec325b49a09d7964b3f6759a34a0d))
* **cli:** df mcp skeleton + initialize handshake — Cycle 5 Phase 1 step 1 ([63c641c](https://github.com/momentiq-ai/dark-factory/commit/63c641cb661dd7c29e433f5796f87359806325da))
* **cli:** df_adr_list + df_adr_read MCP tools — Cycle 5 Phase 1 step 3c ([0d8dbd4](https://github.com/momentiq-ai/dark-factory/commit/0d8dbd4b4b58906b8a08f4b81fd5f2312e9a4f3b))
* **cli:** df_adr_list + df_adr_read MCP tools — Cycle 5 Phase 1 step 3c ([c8c27b8](https://github.com/momentiq-ai/dark-factory/commit/c8c27b86d3bb71dbfa57c391131e96e37b49927e))
* **cli:** df_critics_config MCP tool — Cycle 5 Phase 1 step 3d (closes step 3) ([73d2b6f](https://github.com/momentiq-ai/dark-factory/commit/73d2b6fc8a5eb59564070dcd0f47c08eb2c9bddb))
* **cli:** df_critics_config MCP tool — Cycle 5 Phase 1 step 3d (closes step 3) ([8beedd5](https://github.com/momentiq-ai/dark-factory/commit/8beedd57df88d67de35da1b403dda825c03784b0))
* **cli:** df_cycle_doc_generate + df_adr_generate via sampling — Cycle 5 Phase 1 step 8 ([58f6895](https://github.com/momentiq-ai/dark-factory/commit/58f6895358a01fb939444c084046fa45b6463485))
* **cli:** df_cycle_doc_generate + df_adr_generate via sampling — Cycle 5 Phase 1 step 8 ([ad026b0](https://github.com/momentiq-ai/dark-factory/commit/ad026b0ab4732d7801da8fb063617fb89c6d46a8))
* **cli:** df_cycle_list + df_cycle_read MCP tools — Cycle 5 Phase 1 step 3a ([63f4311](https://github.com/momentiq-ai/dark-factory/commit/63f4311d6b0050fe488777f24bc4462ddc5fc5fb))
* **cli:** df_cycle_list + df_cycle_read MCP tools — Cycle 5 Phase 1 step 3a ([761ad18](https://github.com/momentiq-ai/dark-factory/commit/761ad18e7c263c93d1c39f4394af9f01f15a2645))
* **cli:** df_doctor MCP tool — Cycle 5 Phase 1 step 2 ([153dce3](https://github.com/momentiq-ai/dark-factory/commit/153dce3c73b70132764a716b91ea9aa45bb7e238))
* **cli:** df_doctor MCP tool — Cycle 5 Phase 1 step 2 ([ea46c7e](https://github.com/momentiq-ai/dark-factory/commit/ea46c7e5e44b714816e06412d8f2d26180a7fbcb))
* **cli:** df_findings + df_show_run MCP tools — Cycle 5 Phase 1 step 3b ([c5ddb5f](https://github.com/momentiq-ai/dark-factory/commit/c5ddb5f5cc419864147d6273bf147370613b8735))
* **cli:** df_findings + df_show_run MCP tools — Cycle 5 Phase 1 step 3b ([3e0e2eb](https://github.com/momentiq-ai/dark-factory/commit/3e0e2eb9d29192938aa98deac9e7aad5eca065eb))
* **cli:** df_review + df_review_status + df_bypass MCP tools — Cycle 5 Phase 1 step 6 ([0184c4e](https://github.com/momentiq-ai/dark-factory/commit/0184c4e6b217a1bef4367eb098d87d71a79c4011))
* **cli:** df_review + df_review_status + df_bypass MCP tools — Cycle 5 Phase 1 step 6 ([2bdc9f1](https://github.com/momentiq-ai/dark-factory/commit/2bdc9f111ffb7177e8d76394986ff85f88a0b5c6))
* **cli:** df_stats + df_gate_push MCP tools — Cycle 5 Phase 1 step 5 ([791ceca](https://github.com/momentiq-ai/dark-factory/commit/791cecae21d39c41f1cf0f990cbb00cdddb30553))
* **cli:** df_stats + df_gate_push MCP tools — Cycle 5 Phase 1 step 5 ([4ecb3ec](https://github.com/momentiq-ai/dark-factory/commit/4ecb3ec605a5beeb300337507769affea936042d))
* **cli:** MCP prompts (pure templates) — Cycle 5 Phase 1 step 7 ([0100945](https://github.com/momentiq-ai/dark-factory/commit/0100945060d6a68d2eae3af4e4fd99944bddcb1a))
* **cli:** MCP prompts (pure templates) — Cycle 5 Phase 1 step 7 ([2993a3b](https://github.com/momentiq-ai/dark-factory/commit/2993a3be8bc68fe02ee0179193b757bcd293b81a))
* **cli:** MCP resources surface — Cycle 5 Phase 1 step 4 ([8486fb0](https://github.com/momentiq-ai/dark-factory/commit/8486fb017cc105e296acd99c55fc2a26f2e33894))
* **cli:** MCP resources surface — Cycle 5 Phase 1 step 4 ([5092eaa](https://github.com/momentiq-ai/dark-factory/commit/5092eaaf27c4ba37091c9884575371be14f883cb))
* **cli:** wire elicitation for df_bypass — Cycle 5 Phase 1 step 9 ([c400e23](https://github.com/momentiq-ai/dark-factory/commit/c400e2347e6c446967d758e62423bc3b2cde98b5))
* **cli:** wire elicitation for df_bypass — Cycle 5 Phase 1 step 9 ([5c95d6a](https://github.com/momentiq-ai/dark-factory/commit/5c95d6a979cae31f2f5575b72cb375923bfc89a7))
* **cli:** wire logging/message notifications — Cycle 5 Phase 1 step 10 ([9fcbb8b](https://github.com/momentiq-ai/dark-factory/commit/9fcbb8b06258664db9864ae16d98ffb11a33351d))
* **cli:** wire logging/message notifications — Cycle 5 Phase 1 step 10 ([516e701](https://github.com/momentiq-ai/dark-factory/commit/516e701cbce94bce849b380707ffd871391c6d98))
* **cycle12.2:** df CLI Issue-arg handoff subcommands + MCP signature change ([#69](https://github.com/momentiq-ai/dark-factory/issues/69)) ([3aec608](https://github.com/momentiq-ai/dark-factory/commit/3aec608a0573a2ce07a7a9a6e8e397c078203afb))
* **phase-c:** extract services [#4](https://github.com/momentiq-ai/dark-factory/issues/4)/[#5](https://github.com/momentiq-ai/dark-factory/issues/5)/[#7](https://github.com/momentiq-ai/dark-factory/issues/7)/[#9](https://github.com/momentiq-ai/dark-factory/issues/9) from sage3c ([#2](https://github.com/momentiq-ai/dark-factory/issues/2)) ([4d499b6](https://github.com/momentiq-ai/dark-factory/commit/4d499b6e17b6bb8cabd9e06879f3dd46618bc6d3))
* **phase-d:** extract services [#6](https://github.com/momentiq-ai/dark-factory/issues/6) (Merge Queue Admission) + [#8](https://github.com/momentiq-ai/dark-factory/issues/8) (Audit Trail) — final extraction phase ([#3](https://github.com/momentiq-ai/dark-factory/issues/3)) ([623ac93](https://github.com/momentiq-ai/dark-factory/commit/623ac93b4f4dbf9e15b4713aeab894089f882231))
* **phase-e:** reusable workflow shapes — ends chicken-and-egg ([#4](https://github.com/momentiq-ai/dark-factory/issues/4)) ([26a0a4f](https://github.com/momentiq-ai/dark-factory/commit/26a0a4fe405b20dc951b42539f420669387b2b72))
* **phase-f-local:** port hook-facing CLI subcommands — review/gate-push/doctor/gates/stats (subscription cost model) ([#9](https://github.com/momentiq-ai/dark-factory/issues/9)) ([e55495b](https://github.com/momentiq-ai/dark-factory/commit/e55495bcb5f2ef3bf55534d3c954c4284f1b3618))
* **phase-f:** dogfood — wire real critic + sentinel status-check; validate Phase E workflows end-to-end ([#5](https://github.com/momentiq-ai/dark-factory/issues/5)) ([01765a4](https://github.com/momentiq-ai/dark-factory/commit/01765a409d6e0c69bd2baccc882f74317d6794ae))
* **policy:** injectedConfigAuthoritative — honor caller-injected config when commit touches .agent-review/** (closes [#56](https://github.com/momentiq-ai/dark-factory/issues/56), refs [#57](https://github.com/momentiq-ai/dark-factory/issues/57)) ([#61](https://github.com/momentiq-ai/dark-factory/issues/61)) ([445cedb](https://github.com/momentiq-ai/dark-factory/commit/445cedbdb734f395ee3bb51ab8e76bf75d2bf6b0))
* **schemas+adapters:** per-critic token + retries telemetry — Cycle 6.3 Stage 1 ([#65](https://github.com/momentiq-ai/dark-factory/issues/65)) ([4e99467](https://github.com/momentiq-ai/dark-factory/commit/4e99467ea8d944e37fc96ec28d3b799c454b9630))


### Bug Fixes

* **adapters,workflows:** A2 retry-helpers + Cursor sqlite3 prebuilt (closes [#11](https://github.com/momentiq-ai/dark-factory/issues/11)) ([#13](https://github.com/momentiq-ai/dark-factory/issues/13)) ([dc60d87](https://github.com/momentiq-ai/dark-factory/commit/dc60d8768370bc0633279d356b0e864685005ba1))
* **agent-critic:** upload evidence artifact + surface per-critic errors + loud degradation warning ([#19](https://github.com/momentiq-ai/dark-factory/issues/19)) ([d4fac63](https://github.com/momentiq-ai/dark-factory/commit/d4fac635876f2972128cf25a33fba8beac01e0ca)), closes [#18](https://github.com/momentiq-ai/dark-factory/issues/18)
* **cli:** add adapters barrel so ./adapters subpath export resolves ([#23](https://github.com/momentiq-ai/dark-factory/issues/23)) ([#24](https://github.com/momentiq-ai/dark-factory/issues/24)) ([0d85974](https://github.com/momentiq-ai/dark-factory/commit/0d85974cb604120067d8652c47d7a5e8927ad373))
* **cli:** don't block consumer PRs that run no critic-side quality gates ([#32](https://github.com/momentiq-ai/dark-factory/issues/32)) ([aaf6d3c](https://github.com/momentiq-ai/dark-factory/commit/aaf6d3c95aed5533a0ddc04a3c863e746d9bf8ab))
* **phase-b-publish-pkg:** lazy-load vendor adapters so CLI runs under --ignore-scripts ([#8](https://github.com/momentiq-ai/dark-factory/issues/8)) ([f2d834b](https://github.com/momentiq-ai/dark-factory/commit/f2d834b2c8a9264d0b1d7ab54b58ba2420b21ce6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @momentiq/dark-factory-schemas bumped from 0.2.0-alpha.8 to 0.3.0

## [0.7.0-alpha.9](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v0.6.0-alpha.9...dark-factory-cli-v0.7.0-alpha.9) (2026-05-31)


### Features

* **schemas+adapters:** per-critic token + retries telemetry — Cycle 6.3 Stage 1 ([#65](https://github.com/momentiq-ai/dark-factory/issues/65)) ([4e99467](https://github.com/momentiq-ai/dark-factory/commit/4e99467ea8d944e37fc96ec28d3b799c454b9630))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @momentiq/dark-factory-schemas bumped from 0.1.1-alpha.8 to 0.2.0-alpha.8

## [0.6.0-alpha.9](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v0.5.0-alpha.9...dark-factory-cli-v0.6.0-alpha.9) (2026-05-30)


### Features

* **cli:** df flow — surface PR Flow Assessor records — Cycle 11 Phase 11.1 ([#63](https://github.com/momentiq-ai/dark-factory/issues/63)) ([6869da1](https://github.com/momentiq-ai/dark-factory/commit/6869da18f84f631608fbd61925a57015e46ad852))

## [0.5.0-alpha.9](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v0.4.0-alpha.9...dark-factory-cli-v0.5.0-alpha.9) (2026-05-30)


### Features

* **policy:** injectedConfigAuthoritative — honor caller-injected config when commit touches .agent-review/** (closes [#56](https://github.com/momentiq-ai/dark-factory/issues/56), refs [#57](https://github.com/momentiq-ai/dark-factory/issues/57)) ([#61](https://github.com/momentiq-ai/dark-factory/issues/61)) ([445cedb](https://github.com/momentiq-ai/dark-factory/commit/445cedbdb734f395ee3bb51ab8e76bf75d2bf6b0))

## [0.4.0-alpha.9](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v0.3.0-alpha.9...dark-factory-cli-v0.4.0-alpha.9) (2026-05-30)


### Features

* **cli:** agent handoff protocol — df handoff/accept/rehydrate/handoffs + MCP tools/prompts — Cycle 8 Phase 8.2 ([5818387](https://github.com/momentiq-ai/dark-factory/commit/581838768bfcc6a12c7dbe4406cf4ea6bf82426e))
* **cli:** agent handoff protocol — df handoff/accept/rehydrate/handoffs + MCP tools/prompts — Cycle 8 Phase 8.2 ([c7a5a88](https://github.com/momentiq-ai/dark-factory/commit/c7a5a88a61b186a08dd94683ecd9573c4431cd6c))

## [0.3.0-alpha.9](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v0.2.0-alpha.9...dark-factory-cli-v0.3.0-alpha.9) (2026-05-28)


### Features

* **cli:** add cursor-cli adapter for subscription auth — closes [#28](https://github.com/momentiq-ai/dark-factory/issues/28) ([#52](https://github.com/momentiq-ai/dark-factory/issues/52)) ([6a205d1](https://github.com/momentiq-ai/dark-factory/commit/6a205d1f608229541960643ebf7096ca58e13d5a))

## [0.2.0-alpha.9](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v0.1.1-alpha.9...dark-factory-cli-v0.2.0-alpha.9) (2026-05-27)


### Features

* **cli:** df mcp skeleton + initialize handshake — Cycle 5 Phase 1 step 1 ([0f087c0](https://github.com/momentiq-ai/dark-factory/commit/0f087c09d6cec325b49a09d7964b3f6759a34a0d))
* **cli:** df mcp skeleton + initialize handshake — Cycle 5 Phase 1 step 1 ([63c641c](https://github.com/momentiq-ai/dark-factory/commit/63c641cb661dd7c29e433f5796f87359806325da))
* **cli:** df_adr_list + df_adr_read MCP tools — Cycle 5 Phase 1 step 3c ([0d8dbd4](https://github.com/momentiq-ai/dark-factory/commit/0d8dbd4b4b58906b8a08f4b81fd5f2312e9a4f3b))
* **cli:** df_adr_list + df_adr_read MCP tools — Cycle 5 Phase 1 step 3c ([c8c27b8](https://github.com/momentiq-ai/dark-factory/commit/c8c27b86d3bb71dbfa57c391131e96e37b49927e))
* **cli:** df_critics_config MCP tool — Cycle 5 Phase 1 step 3d (closes step 3) ([73d2b6f](https://github.com/momentiq-ai/dark-factory/commit/73d2b6fc8a5eb59564070dcd0f47c08eb2c9bddb))
* **cli:** df_critics_config MCP tool — Cycle 5 Phase 1 step 3d (closes step 3) ([8beedd5](https://github.com/momentiq-ai/dark-factory/commit/8beedd57df88d67de35da1b403dda825c03784b0))
* **cli:** df_cycle_doc_generate + df_adr_generate via sampling — Cycle 5 Phase 1 step 8 ([58f6895](https://github.com/momentiq-ai/dark-factory/commit/58f6895358a01fb939444c084046fa45b6463485))
* **cli:** df_cycle_doc_generate + df_adr_generate via sampling — Cycle 5 Phase 1 step 8 ([ad026b0](https://github.com/momentiq-ai/dark-factory/commit/ad026b0ab4732d7801da8fb063617fb89c6d46a8))
* **cli:** df_cycle_list + df_cycle_read MCP tools — Cycle 5 Phase 1 step 3a ([63f4311](https://github.com/momentiq-ai/dark-factory/commit/63f4311d6b0050fe488777f24bc4462ddc5fc5fb))
* **cli:** df_cycle_list + df_cycle_read MCP tools — Cycle 5 Phase 1 step 3a ([761ad18](https://github.com/momentiq-ai/dark-factory/commit/761ad18e7c263c93d1c39f4394af9f01f15a2645))
* **cli:** df_doctor MCP tool — Cycle 5 Phase 1 step 2 ([153dce3](https://github.com/momentiq-ai/dark-factory/commit/153dce3c73b70132764a716b91ea9aa45bb7e238))
* **cli:** df_doctor MCP tool — Cycle 5 Phase 1 step 2 ([ea46c7e](https://github.com/momentiq-ai/dark-factory/commit/ea46c7e5e44b714816e06412d8f2d26180a7fbcb))
* **cli:** df_findings + df_show_run MCP tools — Cycle 5 Phase 1 step 3b ([c5ddb5f](https://github.com/momentiq-ai/dark-factory/commit/c5ddb5f5cc419864147d6273bf147370613b8735))
* **cli:** df_findings + df_show_run MCP tools — Cycle 5 Phase 1 step 3b ([3e0e2eb](https://github.com/momentiq-ai/dark-factory/commit/3e0e2eb9d29192938aa98deac9e7aad5eca065eb))
* **cli:** df_review + df_review_status + df_bypass MCP tools — Cycle 5 Phase 1 step 6 ([0184c4e](https://github.com/momentiq-ai/dark-factory/commit/0184c4e6b217a1bef4367eb098d87d71a79c4011))
* **cli:** df_review + df_review_status + df_bypass MCP tools — Cycle 5 Phase 1 step 6 ([2bdc9f1](https://github.com/momentiq-ai/dark-factory/commit/2bdc9f111ffb7177e8d76394986ff85f88a0b5c6))
* **cli:** df_stats + df_gate_push MCP tools — Cycle 5 Phase 1 step 5 ([791ceca](https://github.com/momentiq-ai/dark-factory/commit/791cecae21d39c41f1cf0f990cbb00cdddb30553))
* **cli:** df_stats + df_gate_push MCP tools — Cycle 5 Phase 1 step 5 ([4ecb3ec](https://github.com/momentiq-ai/dark-factory/commit/4ecb3ec605a5beeb300337507769affea936042d))
* **cli:** MCP prompts (pure templates) — Cycle 5 Phase 1 step 7 ([0100945](https://github.com/momentiq-ai/dark-factory/commit/0100945060d6a68d2eae3af4e4fd99944bddcb1a))
* **cli:** MCP prompts (pure templates) — Cycle 5 Phase 1 step 7 ([2993a3b](https://github.com/momentiq-ai/dark-factory/commit/2993a3be8bc68fe02ee0179193b757bcd293b81a))
* **cli:** MCP resources surface — Cycle 5 Phase 1 step 4 ([8486fb0](https://github.com/momentiq-ai/dark-factory/commit/8486fb017cc105e296acd99c55fc2a26f2e33894))
* **cli:** MCP resources surface — Cycle 5 Phase 1 step 4 ([5092eaa](https://github.com/momentiq-ai/dark-factory/commit/5092eaaf27c4ba37091c9884575371be14f883cb))
* **cli:** wire elicitation for df_bypass — Cycle 5 Phase 1 step 9 ([c400e23](https://github.com/momentiq-ai/dark-factory/commit/c400e2347e6c446967d758e62423bc3b2cde98b5))
* **cli:** wire elicitation for df_bypass — Cycle 5 Phase 1 step 9 ([5c95d6a](https://github.com/momentiq-ai/dark-factory/commit/5c95d6a979cae31f2f5575b72cb375923bfc89a7))
* **cli:** wire logging/message notifications — Cycle 5 Phase 1 step 10 ([9fcbb8b](https://github.com/momentiq-ai/dark-factory/commit/9fcbb8b06258664db9864ae16d98ffb11a33351d))
* **cli:** wire logging/message notifications — Cycle 5 Phase 1 step 10 ([516e701](https://github.com/momentiq-ai/dark-factory/commit/516e701cbce94bce849b380707ffd871391c6d98))

## [0.1.1-alpha.9](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v0.1.0-alpha.9...dark-factory-cli-v0.1.1-alpha.9) (2026-05-27)


### Features

* **331.1-B:** extract Critic Orchestrator + Policy Engine + Trusted-Surface Rebind into packages/cli/ ([#1](https://github.com/momentiq-ai/dark-factory/issues/1)) ([4314365](https://github.com/momentiq-ai/dark-factory/commit/4314365e69760356be06ad9948ee97aaa611b55f))
* **phase-c:** extract services [#4](https://github.com/momentiq-ai/dark-factory/issues/4)/[#5](https://github.com/momentiq-ai/dark-factory/issues/5)/[#7](https://github.com/momentiq-ai/dark-factory/issues/7)/[#9](https://github.com/momentiq-ai/dark-factory/issues/9) from sage3c ([#2](https://github.com/momentiq-ai/dark-factory/issues/2)) ([4d499b6](https://github.com/momentiq-ai/dark-factory/commit/4d499b6e17b6bb8cabd9e06879f3dd46618bc6d3))
* **phase-d:** extract services [#6](https://github.com/momentiq-ai/dark-factory/issues/6) (Merge Queue Admission) + [#8](https://github.com/momentiq-ai/dark-factory/issues/8) (Audit Trail) — final extraction phase ([#3](https://github.com/momentiq-ai/dark-factory/issues/3)) ([623ac93](https://github.com/momentiq-ai/dark-factory/commit/623ac93b4f4dbf9e15b4713aeab894089f882231))
* **phase-e:** reusable workflow shapes — ends chicken-and-egg ([#4](https://github.com/momentiq-ai/dark-factory/issues/4)) ([26a0a4f](https://github.com/momentiq-ai/dark-factory/commit/26a0a4fe405b20dc951b42539f420669387b2b72))
* **phase-f-local:** port hook-facing CLI subcommands — review/gate-push/doctor/gates/stats (subscription cost model) ([#9](https://github.com/momentiq-ai/dark-factory/issues/9)) ([e55495b](https://github.com/momentiq-ai/dark-factory/commit/e55495bcb5f2ef3bf55534d3c954c4284f1b3618))
* **phase-f:** dogfood — wire real critic + sentinel status-check; validate Phase E workflows end-to-end ([#5](https://github.com/momentiq-ai/dark-factory/issues/5)) ([01765a4](https://github.com/momentiq-ai/dark-factory/commit/01765a409d6e0c69bd2baccc882f74317d6794ae))


### Bug Fixes

* **adapters,workflows:** A2 retry-helpers + Cursor sqlite3 prebuilt (closes [#11](https://github.com/momentiq-ai/dark-factory/issues/11)) ([#13](https://github.com/momentiq-ai/dark-factory/issues/13)) ([dc60d87](https://github.com/momentiq-ai/dark-factory/commit/dc60d8768370bc0633279d356b0e864685005ba1))
* **agent-critic:** upload evidence artifact + surface per-critic errors + loud degradation warning ([#19](https://github.com/momentiq-ai/dark-factory/issues/19)) ([d4fac63](https://github.com/momentiq-ai/dark-factory/commit/d4fac635876f2972128cf25a33fba8beac01e0ca)), closes [#18](https://github.com/momentiq-ai/dark-factory/issues/18)
* **cli:** add adapters barrel so ./adapters subpath export resolves ([#23](https://github.com/momentiq-ai/dark-factory/issues/23)) ([#24](https://github.com/momentiq-ai/dark-factory/issues/24)) ([0d85974](https://github.com/momentiq-ai/dark-factory/commit/0d85974cb604120067d8652c47d7a5e8927ad373))
* **cli:** don't block consumer PRs that run no critic-side quality gates ([#32](https://github.com/momentiq-ai/dark-factory/issues/32)) ([aaf6d3c](https://github.com/momentiq-ai/dark-factory/commit/aaf6d3c95aed5533a0ddc04a3c863e746d9bf8ab))
* **phase-b-publish-pkg:** lazy-load vendor adapters so CLI runs under --ignore-scripts ([#8](https://github.com/momentiq-ai/dark-factory/issues/8)) ([f2d834b](https://github.com/momentiq-ai/dark-factory/commit/f2d834b2c8a9264d0b1d7ab54b58ba2420b21ce6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @momentiq/dark-factory-schemas bumped from * to 0.1.1-alpha.8
