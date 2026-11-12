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
  "DECK_EXISTS",
  "KIT_NOT_FOUND",
  "KIT_INVALID",
  "SLIDE_NOT_FOUND",
  "RENDER_FAILED",
  "FILE_CONFLICT",
  "WRITE_FAILED",
  "LAST_SLIDE",
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
  description: z.string().optional(),
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

// A blueprint violation (core's Violation). `source` is a slide source or "deck"; `message` is the CLI string.
export const ViolationSchema = z.object({ source: z.string(), code: z.string(), message: z.string() });
export type Violation = z.infer<typeof ViolationSchema>;

// A slide as the editor holds it (data-model: SlideDraft). Mirrors core's SlideDraft.
export const SlideDraftSchema = z.object({
  markdown: z.string().max(200_000),
  template: z.string().nullable(),
  type: z.string().nullable(),
  notes: z.string().max(50_000),
  title: z.string().max(200).nullable(),
  directives: z.record(z.string()),
});
export type SlideDraft = z.infer<typeof SlideDraftSchema>;

// `title` and `template` are as rendered; `draft` is what the file says. `html` is a standalone,
// script-free document for a sandboxed iframe. `file` is the key into DeckDetail.hashes.
export const SlideDocSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  title: z.string(),
  template: z.string(),
  type: z.string().nullable(),
  html: z.string(),
  draft: SlideDraftSchema,
  file: z.string(),
  /** The slide's source as violations name it (a manifest path, or "slide N" in a single file). */
  source: z.string(),
  violations: z.array(ViolationSchema),
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
  /** Template names this deck can use: built-ins, the deck's templates.yml and its kit. */
  templates: z.array(z.string()),
  /** Page types its blueprint defines (empty without a blueprint). */
  types: z.array(z.string()),
  /** False when neither the deck nor its kit has a blueprint: the UI shows no checks. */
  hasBlueprint: z.boolean(),
  /** The whole deck's blueprint violations; messages are exactly what `flipbook check` prints. */
  violations: z.array(ViolationSchema),
});
export type DeckDetail = z.infer<typeof DeckDetailSchema>;

export const DECK_NAME = /^[a-z0-9-]{1,60}$/;

// POST /api/decks (US-2). Core's createDeck validates again; this gives the API its 422 field errors.
export const CreateDeckRequestSchema = z.object({
  name: z.string().regex(DECK_NAME, "Use 1-60 lowercase letters, digits or dashes."),
  title: z.string().trim().min(1, "Use 1-120 characters.").max(120, "Use 1-120 characters."),
  kind: z.enum(["folder", "single"]),
  group: z.string().trim().min(1).nullable(),
});
export type CreateDeckRequest = z.infer<typeof CreateDeckRequestSchema>;

const Hash = z.string().regex(/^[0-9a-f]{64}$/, "Use the sha256 from the last read.");

// POST /api/decks/:id/preview (US-3). Violations stay empty until US-5.
export const PreviewRequestSchema = z.object({
  slideId: z.string().nullable(),
  draft: SlideDraftSchema.nullable(),
});
export const PreviewResponseSchema = z.object({ html: z.string(), violations: z.array(ViolationSchema) });

// PUT /api/decks/:id/slides/:slideId (US-3).
export const SaveSlideRequestSchema = z.object({ baseHash: Hash, draft: SlideDraftSchema });
export const SaveSlideResponseSchema = z.object({
  slide: SlideDocSchema,
  hashes: z.record(z.string()),
  violations: z.array(ViolationSchema),
});

// US-4 structure changes. `baseHash` is presentation.yml's hash (folder) or the single file's.
// Each response carries every slide and hash, since single-file slide IDs are positions.
export const StructureResponseSchema = z.object({
  slides: z.array(SlideDocSchema),
  hashes: z.record(z.string()),
  violations: z.array(ViolationSchema),
});
export type StructureResponse = z.infer<typeof StructureResponseSchema>;
export const AddSlideRequestSchema = z.object({
  baseHash: Hash,
  afterSlideId: z.string().nullable(),
  draft: SlideDraftSchema,
});
export const AddSlideResponseSchema = StructureResponseSchema.extend({ slide: SlideDocSchema });
export const OrderRequestSchema = z.object({ baseHash: Hash, slideIds: z.array(z.string()).max(1000) });
export const DeleteSlideQuerySchema = z.object({ baseHash: Hash });

export const TOKEN_HEADER = "x-flipbook-token";
export const TOKEN_META = "flipbook-token";
export const TOKEN_PLACEHOLDER = "__FLIPBOOK_TOKEN__";
