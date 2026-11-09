import { version } from "../package.json";
import { COMMANDS } from "./commands-table.ts";
import { ARES_TOOLS } from "./mcp-tools.ts";

/** Implemented family-readable records only; private inputs and future integrations are not contracts. */
export const FORMAT_VERSIONS = {
  manifest: 1,
  harnessRound: 1,
  lessonProposal: 1,
  harnessTransition: 1,
  harnessStream: 1,
  harnessExperience: 1,
  harnessFixtureProjection: 1,
  study: 2,
  paperEvidence: 2,
  paperPlan: 1,
  skillProposal: 2,
  studyRegistry: 1,
  watchConfig: 1,
  studyPlan: 1,
  ledgerEvent: 1,
  experimentProtocol: 2,
  experimentSelection: 1,
  experimentFinalSeeds: 1,
  ablateResult: 1,
  finalResult: 1,
  investigateResult: 1,
  executor: 1,
  experimentAttempt: 3,
  studyBundle: 1,
} as const;
export const MEMORY_LEDGER_EVENTS = ["archive.exported", "skill.proposed", "skill.decided", "lesson.proposed", "lesson.decided"] as const;
export const WATCH_LEDGER_EVENTS = ["watch.set", "watch.ran"] as const;
export const LEDGER_EVENTS = [...MEMORY_LEDGER_EVENTS, ...WATCH_LEDGER_EVENTS, "autonomy.set", "harness.round.set", "harness.probe.declared", "harness.contrast.recorded", "harness.composition.recorded", "harness.adoption.decided", "harness.round.closed", "experience.stream.set", "experience.frozen", "retention.pruned", "attempt.pipeline.code", "attempt.pipeline.inputs", "attempt.stage.terminated", "attempt.reuse.preflight", "attempt.reuse.fresh-intent", "attempt.reuse.materialized", "attempt.reuse.miss", "attempt.stage.reused", "paper.plan.set"] as const;
export interface Manifest {
  v: 1;
  name: "ares";
  version: string;
  commands: { name: string; usage: string }[];
  formats: typeof FORMAT_VERSIONS;
  ledgerEvents: typeof LEDGER_EVENTS[number][];
  mcp: { server: "ares"; tools: { name: string; readOnly: boolean }[] };
}
export function manifest(): Manifest {
  return { v: 1, name: "ares", version, commands: COMMANDS.map(({ name, usage }) => ({ name, usage })), formats: { ...FORMAT_VERSIONS }, ledgerEvents: [...LEDGER_EVENTS], mcp: { server: "ares", tools: ARES_TOOLS.map(tool => ({ name: tool.name, readOnly: tool.annotations.readOnlyHint === true && tool.annotations.openWorldHint !== true })) } };
}
