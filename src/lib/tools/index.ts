// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
// One place that maps a tool name to its schema and executor. The agent loop
// resolves calls through here, so an unknown name becomes a tool *result*
// ("no such tool") rather than a crash — models do occasionally hallucinate a
// tool that was never advertised, and the recoverable answer is to tell them.

import type { ToolDefinition } from "./types";
import {
  CREATE_FILE_SCHEMA,
  executeCreateFile,
  prepareCreateFileRecoveredArgs,
  recognizeCreateFileTextForm,
} from "./create-file";
import { EDIT_FILE_SCHEMA, executeEditFile } from "./edit-file";
import { GENERATE_IMAGE_SCHEMA, executeGenerateImage } from "./generate-image";
import { OCR_IMAGE_SCHEMA, executeOcrImage } from "./ocr-image";
import { RUN_CODE_SCHEMA, executeRunCode } from "./run-code";
import { WEB_SEARCH_SCHEMA, executeWebSearch } from "./web-search";
import type { ToolSchema } from "@/lib/ai";

export type { AttachmentRef, ToolArtifacts, ToolContext, ToolDefinition, ToolResult } from "./types";

const DEFINITIONS: ToolDefinition[] = [
  { name: "web_search", schema: WEB_SEARCH_SCHEMA, execute: executeWebSearch },
  { name: "generate_image", schema: GENERATE_IMAGE_SCHEMA, execute: executeGenerateImage },
  {
    name: "create_file",
    schema: CREATE_FILE_SCHEMA,
    execute: executeCreateFile,
    recognizeTextForm: recognizeCreateFileTextForm,
    prepareRecoveredArgs: prepareCreateFileRecoveredArgs,
  },
  { name: "edit_file", schema: EDIT_FILE_SCHEMA, execute: executeEditFile },
  { name: "run_code", schema: RUN_CODE_SCHEMA, execute: executeRunCode },
  { name: "ocr_image", schema: OCR_IMAGE_SCHEMA, execute: executeOcrImage },
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

/**
 * The recovery-side view of the registry, for parseTextToolCalls'
 * bare-arguments path. Built here because the recognizers live on
 * ToolDefinition (registry-side) and can never ride on ToolSchema, which is
 * JSON-stringified into the provider payload.
 */
export function toolRecoveryInfos(): { name: string; required: string[]; properties: Record<string, unknown>; recognizeTextForm?(obj: Record<string, unknown>): boolean }[] {
  return DEFINITIONS.map((tool) => {
    const params = tool.schema.function.parameters as { required?: unknown; properties?: unknown };
    const required = Array.isArray(params.required)
      ? (params.required as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const properties =
      params.properties && typeof params.properties === "object" && !Array.isArray(params.properties)
        ? (params.properties as Record<string, unknown>)
        : {};
    return {
      name: tool.schema.function.name,
      required,
      properties,
      ...(tool.recognizeTextForm ? { recognizeTextForm: (obj: Record<string, unknown>) => tool.recognizeTextForm!(obj) } : {}),
    };
  });
}

export const TOOL_NAMES = DEFINITIONS.map((tool) => tool.name);
