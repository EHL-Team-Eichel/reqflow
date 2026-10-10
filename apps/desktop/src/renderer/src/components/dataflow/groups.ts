import type { BlockGroup } from "@reqflow/core";

export const GROUP_STYLE: Record<
  BlockGroup,
  { name: string; text: string; tile: string; border: string }
> = {
  structure: {
    name: "Structure",
    text: "text-group-structure",
    tile: "bg-group-structure/10 text-group-structure",
    border: "!border-group-structure",
  },
  source: {
    name: "Source",
    text: "text-group-source",
    tile: "bg-group-source/10 text-group-source",
    border: "!border-group-source",
  },
  ai: {
    name: "AI",
    text: "text-group-ai",
    tile: "bg-group-ai/10 text-group-ai",
    border: "!border-group-ai",
  },
  human: {
    name: "Human",
    text: "text-group-human",
    tile: "bg-group-human/10 text-group-human",
    border: "!border-group-human",
  },
  output: {
    name: "Output",
    text: "text-group-output",
    tile: "bg-group-output/10 text-group-output",
    border: "!border-group-output",
  },
};
