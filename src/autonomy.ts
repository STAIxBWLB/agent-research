export const AUTONOMY_MODES = ["auto", "gates", "copilot", "step"] as const;
export const PHASES = ["scope", "literature", "hypotheses", "design", "investigate", "ablate", "final", "posthoc", "write", "review", "archive"] as const;
export type AutonomyMode = typeof AUTONOMY_MODES[number];
export type Phase = typeof PHASES[number];
export type Autonomy = AutonomyMode | { default: AutonomyMode; phases: Partial<Record<Phase, AutonomyMode>> };

/** Direct gate mappings are explicit; plan gates receive their declared guarded phase. */
export const GATE_PHASES = { scope: "scope", screen: "literature", design: "design", final: "final", review: "review" } as const satisfies Record<string, Phase>;

function refuse(field: string, reason: string): never {
  throw new Error(`${field}: ${reason}; correct the policy and retry ares autonomy set with a supported mode and phase`);
}
function object(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) && (Object.getPrototypeOf(raw) === Object.prototype || Object.getPrototypeOf(raw) === null);
}
export function validateAutonomyMode(raw: unknown): AutonomyMode {
  if (typeof raw !== "string" || !AUTONOMY_MODES.includes(raw as AutonomyMode)) refuse("autonomy.mode", "expected auto, gates, copilot or step");
  return raw as AutonomyMode;
}
export function validatePhase(raw: unknown): Phase {
  if (typeof raw !== "string" || !PHASES.includes(raw as Phase)) refuse("autonomy.phase", `expected one of ${PHASES.join(", ")}`);
  return raw as Phase;
}
/** Validate strictly and return a detached policy, leaving the input unchanged. */
export function validateAutonomy(raw: unknown): Autonomy {
  if (typeof raw === "string") return validateAutonomyMode(raw);
  if (!object(raw)) refuse("autonomy", "mode string or policy object required");
  for (const key of Reflect.ownKeys(raw)) if (key !== "default" && key !== "phases") refuse("autonomy", "unknown policy field");
  const mode = validateAutonomyMode(raw.default);
  if (!object(raw.phases)) refuse("autonomy.phases", "phase-to-mode object required");
  const phases: Partial<Record<Phase, AutonomyMode>> = {};
  for (const key of Reflect.ownKeys(raw.phases)) {
    const phase = validatePhase(key);
    phases[phase] = validateAutonomyMode(raw.phases[phase]);
  }
  return { default: mode, phases };
}

/** Unknown gate kinds and phase-ambiguous plan gates use the study default. */
export function resolveAutonomy(policy: Autonomy, gate: string, guardedPhase?: Phase): AutonomyMode {
  if (typeof policy === "string") return policy;
  const phase = gate.startsWith("plan:") ? guardedPhase : Object.hasOwn(GATE_PHASES, gate) ? GATE_PHASES[gate as keyof typeof GATE_PHASES] : undefined;
  return phase === undefined ? policy.default : policy.phases[phase] ?? policy.default;
}
