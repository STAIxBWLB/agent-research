import { citationOccurrences } from "../lit/cite.ts";
import { isVerified, type Candidate } from "../lit/candidates.ts";
import type { PaperPlan } from "./plan.ts";

export const DEPENDENCY_CODES = ["uncited-dependency", "undeclared-metric"] as const;
export type DependencyFindingCode = typeof DEPENDENCY_CODES[number];
export interface PaperDependencyHit {
  code: DependencyFindingCode;
  severity: "blocking";
  dependencyId?: string;
  start: number;
  end: number;
  message: string;
}

/** Literal citation presence and current verification only; dependency names are never matched to prose. */
export function paperDependencyFindings(citationText: string, plan: PaperPlan, candidates: Candidate[], protocolMetrics: readonly string[]): PaperDependencyHit[] {
  const dependencies = plan.dependencies ?? [];
  if (!dependencies.length) return [];
  const occurring = new Set(citationOccurrences(citationText).map(hit => hit.key)), verified = new Map<string, boolean>(), hits: PaperDependencyHit[] = [];
  for (const dependency of dependencies) {
    if (!dependency.cites?.length) continue;
    const absent = dependency.cites.every(key => !occurring.has(key));
    let stale: string | undefined;
    for (const key of dependency.cites) {
      let current = verified.get(key);
      if (current === undefined) {
        const matches = candidates.filter(candidate => candidate.citekey === key);
        current = matches.length === 1 && matches[0]!.status === "included" && isVerified(matches[0]!);
        verified.set(key, current);
      }
      if (!current) stale ??= key;
    }
    if (absent) hits.push({code: "uncited-dependency", severity: "blocking", dependencyId: dependency.id, start: 0, end: 0,
      message: `dependency ${dependency.id.slice(0, 64)} (${dependency.kind}) has no citation in the manuscript; cite @${dependency.cites[0]!.slice(0, 80)} or another of its keys in prose, or replace its cites with a written waiver`});
    else if (stale) hits.push({code: "uncited-dependency", severity: "blocking", dependencyId: dependency.id, start: 0, end: 0,
      message: `dependency ${dependency.id.slice(0, 64)} citation @${stale.slice(0, 80)} is no longer included and identifier-verified; re-verify it with ares lit verify, route another verified key, or write a waiver`});
  }
  const declared = new Set(dependencies.filter(dependency => dependency.kind === "metric").map(dependency => dependency.name));
  for (const metric of protocolMetrics) {
    const name = metric.trim();
    if (declared.has(name)) continue;
    hits.push({code: "undeclared-metric", severity: "blocking", start: 0, end: 0,
      message: `protocol metric ${name.slice(0, 80)} has no metric dependency; declare it in paper plan set with verified cites or a written waiver`});
  }
  return hits;
}
