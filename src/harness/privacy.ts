import {urlOrKeyLike} from "../privacy.ts";
/** Shared conservative markers for authored round metadata and synthetic producer projections. */
const CREDENTIAL = /bearer\s+[a-z0-9._-]{8,}|(?:api[_-]?key|secret|password|(?:access[_-]?)?token|credential)\s*[:=]\s*\S+|sk-[a-z0-9_-]{16,}|(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}/i;
export function hasHarnessCredential(value: string): boolean {return !!urlOrKeyLike(value) || CREDENTIAL.test(value);}
