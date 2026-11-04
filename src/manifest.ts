import { version } from "../package.json";
import { COMMANDS } from "./commands-table.ts";

/** Implemented family-readable records only; private inputs and future integrations are not contracts. */
export const FORMAT_VERSIONS = {
  manifest: 1,
  study: 1,
  studyPlan: 1,
  ledgerEvent: 1,
  experimentProtocol: 1,
  experimentSelection: 1,
  experimentFinalSeeds: 1,
  ablateResult: 1,
  investigateResult: 1,
  executor: 1,
  experimentAttempt: 1,
} as const;
export interface Manifest {
  v: 1;
  name: "ares";
  version: string;
  commands: { name: string; usage: string }[];
  formats: typeof FORMAT_VERSIONS;
}
export function manifest(): Manifest {
  return { v: 1, name: "ares", version, commands: COMMANDS.map(({ name, usage }) => ({ name, usage })), formats: { ...FORMAT_VERSIONS } };
}
