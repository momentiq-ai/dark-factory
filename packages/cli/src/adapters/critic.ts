import type { LoadedConfig } from "../policy/config.js";
import type {
  CriticConfig,
  CriticResult,
  DoctorCheck,
  ReviewPacket,
  ReviewSeverity,
  TelemetryEvent,
} from "@momentiq/dark-factory-schemas";

export interface CriticReviewOptions {
  blockingSeverities: ReviewSeverity[];
  signal?: AbortSignal;
  emit?: (event: TelemetryEvent) => void;
  diagnosticsDir?: string;
}

export interface CriticAdapter {
  readonly id: string;
  /**
   * Cycle 322.2 Component 3 — environment variables this adapter requires
   * to authenticate. The CLI's `maybeReexecUnderDoppler` walks required
   * critics' adapters and re-execs under `doppler run` when any required
   * critic env var is unset. Optional (`required: false`) critics handle
   * missing keys inside `review()` so shadow-mode adapters remain
   * informational instead of becoming preflight blockers.
   *
   * Existing adapters declare their own keys (`CURSOR_API_KEY`,
   * `GEMINI_API_KEY`, `XAI_API_KEY`). An adapter that needs no secrets
   * (e.g., a future deterministic linter critic) declares an empty tuple
   * `[] as const`.
   */
  readonly requiredEnvVars: readonly string[];
  review(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
  ): Promise<CriticResult>;
  doctor(critic: CriticConfig): Promise<DoctorCheck[]>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, CriticAdapter>();

  register(adapter: CriticAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  resolve(id: string): CriticAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(
        `no adapter registered for id "${id}". Registered: ${[...this.adapters.keys()].join(", ") || "(none)"}`,
      );
    }
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}

/**
 * Cycle 322.2 Component 3 (updated for Cycle 322.3 Codex PR-1429 P2 #5) —
 * collect `requiredEnvVars` for PREFLIGHT purposes (the CLI's Doppler
 * re-exec walk). `union` includes every configured critic so optional
 * shadow critics can still load their Doppler-backed keys opportunistically
 * and emit calibration data. `requiredUnion` includes only required critics;
 * it is the subset allowed to make a failed re-exec a hard preflight block.
 *
 * An adapter referenced by config but not present in the registry is logged
 * to the returned `unregistered` list rather than silently treated as "no
 * requirements" — the doctor surfaces that misregistration so a typo in
 * `.agent-review/config.json` doesn't accidentally short-circuit the
 * Doppler re-exec. Misregistration is checked across ALL critics (required
 * AND optional) because a config typo is a config typo regardless of the
 * critic's required flag.
 *
 * The result `union` is sorted for stable diagnostic output.
 *
 * Lives here (next to AdapterRegistry) rather than in cli.ts so the helper
 * can be imported by tests and by alternative entry points without pulling
 * in `cli.ts`'s `void main()` side effect.
 */
export function collectRequiredEnvVars(
  loaded: LoadedConfig,
  registry: AdapterRegistry,
  // Cycle 322.7 — when a profile is active, the CLI passes the
  // profile's allowlist so we don't preflight credentials for critics
  // that won't actually run. Without this, `review --profile local`
  // could fail Doppler re-exec because a cloud-only critic's required
  // env var was unset, even though the local profile excludes that
  // critic. (Codex P2 on PR #1468.) When `activeCriticIds` is undefined,
  // we walk every configured critic (back-compat, no profile / no
  // profiles map in config).
  activeCriticIds?: ReadonlyArray<string> | ReadonlySet<string>,
): { union: string[]; requiredUnion: string[]; unregistered: string[] } {
  const union = new Set<string>();
  const requiredUnion = new Set<string>();
  const unregistered: string[] = [];
  const allowlist = activeCriticIds
    ? activeCriticIds instanceof Set
      ? activeCriticIds
      : new Set(activeCriticIds)
    : undefined;
  for (const critic of loaded.config.critics) {
    if (allowlist && !allowlist.has(critic.id)) continue;
    if (!registry.has(critic.adapter)) {
      unregistered.push(critic.adapter);
      continue;
    }
    const adapter = registry.resolve(critic.adapter);
    for (const v of adapter.requiredEnvVars) {
      union.add(v);
      if (critic.required) requiredUnion.add(v);
    }
  }
  return { union: [...union].sort(), requiredUnion: [...requiredUnion].sort(), unregistered };
}
