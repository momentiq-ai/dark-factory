# Changelog

## [1.1.0](https://github.com/momentiq-ai/dark-factory/compare/dark-factory-cli-v1.0.0...dark-factory-cli-v1.1.0) (2026-06-02)


### Features

* **adapters/codex-sdk:** expose sandbox_mode for trusted-container contexts ([#98](https://github.com/momentiq-ai/dark-factory/issues/98)) ([ada1ab2](https://github.com/momentiq-ai/dark-factory/commit/ada1ab2982670734bb7e5e2f6c9fb078c43482bc)), closes [#68](https://github.com/momentiq-ai/dark-factory/issues/68)
* **cli:** bounded lockfile strategy for review-packet ([#104](https://github.com/momentiq-ai/dark-factory/issues/104)) ([891ff30](https://github.com/momentiq-ai/dark-factory/commit/891ff303e12324566254eb04fba84a69da6129ed)), closes [#67](https://github.com/momentiq-ai/dark-factory/issues/67)


### Bug Fixes

* **cli:** loud diagnostic for zero-evidence reviews + df doctor triage ([#96](https://github.com/momentiq-ai/dark-factory/issues/96)) ([3374540](https://github.com/momentiq-ai/dark-factory/commit/337454069f07085f552e093d045e4462c56ebc98)), closes [#51](https://github.com/momentiq-ai/dark-factory/issues/51)
* **cycle-doc-validator:** narrow plan-PR scope to docs/roadmap/cycles/cycle*.md ([#95](https://github.com/momentiq-ai/dark-factory/issues/95)) ([73a4942](https://github.com/momentiq-ai/dark-factory/commit/73a49422f992b9da76a34dccab1aa80a6dcea4f2)), closes [#25](https://github.com/momentiq-ai/dark-factory/issues/25)
* **mcp:** handoff/rehydrate prompts to v2 Issue-anchored + drop deprecation note ([#99](https://github.com/momentiq-ai/dark-factory/issues/99)) ([946f323](https://github.com/momentiq-ai/dark-factory/commit/946f323f69f9a2d53c63472ce44c345e94aa0142)), closes [#79](https://github.com/momentiq-ai/dark-factory/issues/79) [#72](https://github.com/momentiq-ai/dark-factory/issues/72)
* **observability:** default sink for self-mod-guard splits info→stdout, warn→stderr ([#97](https://github.com/momentiq-ai/dark-factory/issues/97)) ([ddfc22f](https://github.com/momentiq-ai/dark-factory/commit/ddfc22f7f611be331f68ade9e86122cdb1b19942)), closes [#57](https://github.com/momentiq-ai/dark-factory/issues/57)


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
