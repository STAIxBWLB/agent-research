// Deterministic integer helpers shared by the execution-reuse pilot stages.
// Pure functions over declared inputs only: no clock, randomness, locale or filesystem state.
export const SCALE = 7;
export const OFFSET = 13;

export function scale(values) {
  return values.map(value => value * SCALE + OFFSET);
}

// Byte-exact serialization: insertion order, trailing newline, no whitespace variance.
export function stableJson(value) {
  return JSON.stringify(value) + "\n";
}
