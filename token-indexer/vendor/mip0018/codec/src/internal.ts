// Internal entry point for tests (rule mutations, fuzzing). Not a stable API.
export { ALL_CODEC_RULES, withCodecRules, type CodecRules } from './rules.ts';
export { decodePayloadWith, BoundsInvariantError } from './decode.ts';
export { classifyEventWith } from './classify.ts';
export { checkValue, decodeUintWith } from './values.ts';
