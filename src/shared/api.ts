// Contracts shared by the Studio server and UI (tech-spec: api-contracts.md, data-model.md).
import { z } from "zod";

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "FORBIDDEN_ORIGIN",
  "PATH_OUTSIDE_ROOT",
  "NOT_FOUND",
  "DECK_NOT_FOUND",
  "DECK_LOAD_FAILED",
  "INTERNAL",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  path: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ErrorEnvelopeSchema = z.object({ error: ApiErrorSchema });

export const KitRefSchema = z.object({
  kind: z.enum(["theme", "template", "blueprint", "group"]),
  name: z.string(),
  scope: z.enum(["library", "deck", "builtin"]),
});
export type KitRef = z.infer<typeof KitRefSchema>;

export const DeckSummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  kind: z.enum(["folder", "single"]),
  title: z.string(),
  slideCount: z.number().int().nonnegative(),
  group: z.string().nullable(),
  error: ApiErrorSchema.nullable(),
});
export type DeckSummary = z.infer<typeof DeckSummarySchema>;

export const WorkspaceSchema = z.object({
  root: z.string(),
  decks: z.array(DeckSummarySchema),
  library: z.object({
    themes: z.array(KitRefSchema),
    templates: z.array(KitRefSchema),
    blueprints: z.array(KitRefSchema),
    groups: z.array(KitRefSchema),
  }),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

// US-1 subset of SlideDoc. `html` is a standalone, script-free document for a sandboxed iframe.
export const SlideDocSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  title: z.string(),
  template: z.string(),
  type: z.string().nullable(),
  html: z.string(),
});
export type SlideDoc = z.infer<typeof SlideDocSchema>;

export const DeckDetailSchema = z.object({
  id: z.string(),
  path: z.string(),
  kind: z.enum(["folder", "single"]),
  title: z.string(),
  theme: z.string(),
  group: z.string().nullable(),
  style: z.string().nullable(),
  slides: z.array(SlideDocSchema),
  hashes: z.record(z.string()),
});
export type DeckDetail = z.infer<typeof DeckDetailSchema>;

export const TOKEN_HEADER = "x-flipbook-token";
export const TOKEN_META = "flipbook-token";
export const TOKEN_PLACEHOLDER = "__FLIPBOOK_TOKEN__";
