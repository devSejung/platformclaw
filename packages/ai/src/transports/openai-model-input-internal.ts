import type { ResolvedOpenAICompletionsCompat } from "./openai-completions-compat.js";
import type { OpenAIModeModel } from "./openai-transport-shared.js";

// Api keeps custom string IDs via an intersection; preserve primitive leaves before recursion.
type ReadonlyTransportData<T> = T extends string | number | boolean | bigint | symbol
  ? T
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyTransportData<T[K]> }
    : T;

// Transport shaping reads snapshots; the public mutable model DTO stays unchanged.
export type OpenAIModelInput = ReadonlyTransportData<OpenAIModeModel>;

export type ReadonlyResolvedOpenAICompletionsCompat = Omit<
  ReadonlyTransportData<ResolvedOpenAICompletionsCompat>,
  "thinkingFormat"
> & { readonly thinkingFormat: string };
