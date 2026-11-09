import {join} from "node:path";
import {commit, sha256, type Actor} from "../src/study.ts";
import {foldSkills, SKILL_BYTES, validateSkillProposal} from "../src/memory/skills.ts";
/** Native historical v1 record, never a production write API. */
export function legacySkillFixture(dir: string, raw: unknown, actor: Actor) {
  const proposal = validateSkillProposal(raw), list = (values: string[]) => values.map(value => `- ${value.replaceAll("\n", "\n  ")}`).join("\n");
  const content = `---\nskillProposal: 1\nname: ${proposal.name}\n---\n\n# ${proposal.name}\n\n${proposal.summary}\n\n## Steps\n\n${list(proposal.steps)}\n\n## Evidence\n\n${list(proposal.evidence)}\n`;
  const events = commit(dir, [[join(dir, "proposals", "skills", proposal.name + ".md"), content, SKILL_BYTES]], [{actor, type: "skill.proposed", data: {skillProposal: 1, proposal, sha256: sha256(content)}}]);
  return foldSkills(events)[0]!;
}
