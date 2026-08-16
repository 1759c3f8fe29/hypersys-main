// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
// One place that maps a tool name to its schema and executor. The agent loop
// resolves calls through here, so an unknown name becomes a tool *result*
// ("no such tool") rather than a crash — models do occasionally hallucinate a
// tool that was never advertised, and the recoverable answer is to tell them.

import type { ToolDefinition } from "./types";
import { CREATE_FILE_SCHEMA, executeCreateFile } from "./create-file";
import { EDIT_FILE_SCHEMA, executeEditFile } from "./edit-file";
import { GENERATE_IMAGE_SCHEMA, executeGenerateImage } from "./generate-image";
import { RUN_CODE_SCHEMA, executeRunCode } from "./run-code";
import { WEB_SEARCH_SCHEMA, executeWebSearch } from "./web-search";
import type { ToolSchema } from "@/lib/ai";

export type { AttachmentRef, ToolArtifacts, ToolContext, ToolDefinition, ToolResult } from "./types";

const DEFINITIONS: ToolDefinition[] = [
  { name: "web_search", schema: WEB_SEARCH_SCHEMA, execute: executeWebSearch },
  { name: "generate_image", schema: GENERATE_IMAGE_SCHEMA, execute: executeGenerateImage },
  { name: "create_file", schema: CREATE_FILE_SCHEMA, execute: executeCreateFile },
  { name: "edit_file", schema: EDIT_FILE_SCHEMA, execute: executeEditFile },
  { name: "run_code", schema: RUN_CODE_SCHEMA, execute: executeRunCode },
];

export const TOOL_REGISTRY: Record<string, ToolDefinition> = Object.fromEntries(
  DEFINITIONS.map((tool) => [tool.name, tool]),
);

export function getTool(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY[name];
}

/** The schemas to advertise on a request. Order is the order the model sees. */
export function toolSchemas(): ToolSchema[] {
  return DEFINITIONS.map((tool) => tool.schema);
}

export const TOOL_NAMES = DEFINITIONS.map((tool) => tool.name);
