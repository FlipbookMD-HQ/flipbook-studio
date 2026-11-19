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
  "BLUEPRINT_FAILED",
  "KIT_EXISTS",
  "BUILT_IN_READONLY",
  "RESERVED_NAME",
  "DEPENDENCY_MISSING",
  "JOB_RUNNING",
  "JOB_NOT_FOUND",
  "EXPORT_FAILED",
  "SETTINGS_UNSUPPORTED",
  "PROVIDER_EXISTS",
  "PROVIDER_NOT_FOUND",
  "LLM_NOT_CONFIGURED",
  "LLM_UNREACHABLE",
  "LLM_UNAUTHORIZED",
  "LLM_MODEL_NOT_FOUND",
  "LLM_TIMEOUT",
  "LLM_BAD_OUTPUT",
  "LLM_RATE_LIMITED",
  "LLM_NO_CREDIT",
  "CANCELLED",
  "PROPOSAL_NOT_FOUND",
  "STALE_PROPOSAL",
  "ASSET_TOO_LARGE",
  "ASSET_TYPE",
  "ASSET_CONTENT_MISMATCH",
  "ASSET_IN_USE",
  "ASSET_NOT_FOUND",
  "UNDO_CONFLICT",
  "NOTHING_TO_UNDO",
  "NOTHING_TO_REDO",
  "SOURCE_TOO_LARGE",
  "SOURCE_TYPE",
  "SOURCE_ENCODING",
  "SOURCE_UNREADABLE",
  "SOURCE_EXPIRED",
  // US-23: version history (git).
  "GIT_NOT_INSTALLED",
  "GIT_NOT_A_REPO",
  "GIT_ALREADY_A_REPO",
  "GIT_AUTHOR_MISSING",
  "GIT_BUSY",
  "GIT_COMMIT_FAILED",
  "GIT_TIMEOUT",
  "NO_CHANGES",
  "VERSION_NOT_FOUND",
  // US-26: restore a whole deck from a version.
  "DECK_DIRTY",
  "VERSION_STALE",
  "INTERNAL",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  path: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
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
  /** Deck-scope kit files a folder deck has (presentation.css, templates.yml, blueprint.yml). */
  deckKits: z.array(z.enum(["theme", "template", "blueprint"])),
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
  directives: z.record(z.string(), z.string()),
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
  hashes: z.record(z.string(), z.string()),
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

// POST /api/decks/:id/duplicate (US-20, D26). The copy goes next to the original.
export const DuplicateDeckRequestSchema = z.object({
  name: z.string().regex(DECK_NAME, "Use 1-60 lowercase letters, digits or dashes."),
  title: z.string().trim().min(1, "Use 1-120 characters.").max(120, "Use 1-120 characters."),
});
export type DuplicateDeckRequest = z.infer<typeof DuplicateDeckRequestSchema>;
export const DuplicateDeckResponseSchema = z.object({
  deckId: z.string(),
  /** Symlinks left out of the copy, relative to the deck. */
  skipped: z.array(z.string()),
});
export type DuplicateDeckResponse = z.infer<typeof DuplicateDeckResponseSchema>;

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
  hashes: z.record(z.string(), z.string()),
  violations: z.array(ViolationSchema),
});

// US-4 structure changes. `baseHash` is presentation.yml's hash (folder) or the single file's.
// Each response carries every slide and hash, since single-file slide IDs are positions.
export const StructureResponseSchema = z.object({
  slides: z.array(SlideDocSchema),
  hashes: z.record(z.string(), z.string()),
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

// US-17: undo and redo (tech-spec D21). The labels of the next undo and redo, or null.
export const HistorySchema = z.object({ undo: z.string().nullable(), redo: z.string().nullable() });
export type History = z.infer<typeof HistorySchema>;
export const UndoResponseSchema = StructureResponseSchema.extend({ history: HistorySchema });
export type UndoResponse = z.infer<typeof UndoResponseSchema>;

// US-16: deck images (tech-spec D18-D20).
export const ASSET_MAX_BYTES = 8 * 1024 * 1024;
export const ASSET_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"] as const;
export const AssetUseSchema = z.object({
  deckId: z.string(),
  deckPath: z.string(),
  /** null when the deck's own theme (presentation.css) uses the image. */
  slideId: z.string().nullable(),
  label: z.string(),
});
export type AssetUse = z.infer<typeof AssetUseSchema>;
export const DeckAssetSchema = z.object({
  /** Relative to the deck root (or the single file's folder): "assets/cover.png". */
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  mime: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  usedBy: z.array(AssetUseSchema),
});
export type DeckAsset = z.infer<typeof DeckAssetSchema>;
export const DeckAssetsResponseSchema = z.object({ assets: z.array(DeckAssetSchema) });
export type DeckAssetsResponse = z.infer<typeof DeckAssetsResponseSchema>;
export const UploadAssetResponseSchema = z.object({ asset: DeckAssetSchema });
export type UploadAssetResponse = z.infer<typeof UploadAssetResponseSchema>;
export const DeleteAssetQuerySchema = z.object({ force: z.enum(["1"]).optional() });

// US-7: kits (themes first; templates, blueprints and groups follow in US-8 to US-10).
export const KIT_KINDS = ["theme", "template", "blueprint", "group"] as const;
export const KitKindSchema = z.enum(KIT_KINDS);
export type KitKind = z.infer<typeof KitKindSchema>;
export const KitScopeSchema = z.enum(["library", "deck", "builtin"]);
export type KitScope = z.infer<typeof KitScopeSchema>;
const KIT_SOURCE = z.string().max(512 * 1024);

export const KitDocSchema = z.object({
  ref: z.object({
    kind: KitKindSchema,
    name: z.string(),
    scope: KitScopeSchema,
    deckId: z.string().optional(),
  }),
  source: z.string(),
  /** The normalizer's output for YAML kits; null for CSS or an invalid file. */
  parsed: z.unknown(),
  hash: z.string(),
  builtIn: z.boolean(),
  /** Why the file on disk doesn't validate, or null. */
  invalid: z.string().nullable(),
  /** Workspace decks whose style, group or deck scope uses this kit. */
  usedBy: z.array(z.string()),
});
export type KitDoc = z.infer<typeof KitDocSchema>;

export const KitQuerySchema = z.object({ scope: KitScopeSchema, deckId: z.string().optional() });
export const CreateKitRequestSchema = z.object({
  name: z.string().max(60),
  scope: z.enum(["library", "deck"]),
  deckId: z.string().optional(),
  source: KIT_SOURCE,
});
export type CreateKitRequest = z.infer<typeof CreateKitRequestSchema>;
export const UpdateKitRequestSchema = z.object({
  scope: KitScopeSchema,
  deckId: z.string().optional(),
  /** null only when a deck-template patch creates templates.yml. */
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  source: KIT_SOURCE.optional(),
  /** RFC 7386 merge patch for YAML kits. A deck template patch may be null (removes it). */
  patch: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type UpdateKitRequest = z.infer<typeof UpdateKitRequestSchema>;
export const KitPreviewRequestSchema = z.object({
  source: KIT_SOURCE,
  /** Preview on this deck's slides instead of the sample deck. */
  deckId: z.string().optional(),
  /** Where a theme's url() files live without a deck: the library (default) or the built-ins. */
  scope: z.enum(["library", "builtin"]).optional(),
  /** Template previews: the template's name (defaults to "preview"). */
  name: z.string().max(60).optional(),
});
export const KitPreviewResponseSchema = z.object({
  html: z.string(),
  errors: z.array(z.string()),
  affectedSlides: z.array(ViolationSchema).optional(),
});
export type KitPreviewResponse = z.infer<typeof KitPreviewResponseSchema>;

// US-10: media kits (groups).
const GROUP_NAME = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,59}$/, "Use lowercase letters, digits, - or _ (start with a letter).");
export const CopyGroupRequestSchema = z.object({
  toName: GROUP_NAME,
  /** Where the group being copied lives (default: library, then built-in). */
  scope: z.enum(["library", "builtin"]).optional(),
});
export type CopyGroupRequest = z.infer<typeof CopyGroupRequestSchema>;
// POST /api/kits/:kind/:name/copy (US-20, D27). Core checks the name against the kind's rules.
export const CopyKitRequestSchema = z.object({
  toName: z.string().min(1).max(60),
  /** Where the piece being copied lives (default: library, then built-in). */
  scope: z.enum(["library", "builtin"]).optional(),
});
export type CopyKitRequest = z.infer<typeof CopyKitRequestSchema>;
export const RenameGroupRequestSchema = z.object({
  toName: GROUP_NAME,
  baseHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RenameGroupRequest = z.infer<typeof RenameGroupRequestSchema>;
export const RenameGroupResponseSchema = z.object({
  kit: KitDocSchema,
  /** Workspace decks still naming the old group: they won't load until updated. */
  decksUsingOldName: z.array(z.string()),
});
export type RenameGroupResponse = z.infer<typeof RenameGroupResponseSchema>;

// US-6: present and export.
export const PresentRequestSchema = z.object({ slideIndex: z.number().int().nonnegative().optional() });
export const PresentResponseSchema = z.object({ url: z.string(), announcerUrl: z.string() });

export const ExportRequestSchema = z.object({
  /** A core preset name (GET /api/decks/:id/exports lists them). */
  preset: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  format: z.enum(["png", "video"]),
  /** Workspace-relative folder. Defaults to configuration.yml's export.output, else exports/<deck>/<preset>-<format>. */
  outputDir: z.string().min(1).max(500).optional(),
  /** Video length in seconds; defaults to configuration.yml's export.duration. */
  duration: z.number().positive().max(1800).optional(),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export const ExportJobSchema = z.object({
  id: z.string(),
  deckId: z.string(),
  preset: z.string(),
  format: z.enum(["png", "video"]),
  state: z.enum(["running", "done", "failed", "cancelled"]),
  progress: z.object({ done: z.number(), total: z.number() }),
  /** Workspace-relative output folder. */
  outputDir: z.string().nullable(),
  files: z.array(z.string()),
  error: ApiErrorSchema.nullable(),
});
export type ExportJob = z.infer<typeof ExportJobSchema>;

/** SSE events on GET /api/jobs/:id/events. A new connection first gets the current state. */
export const JobEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), done: z.number(), total: z.number() }),
  z.object({ type: z.literal("done"), outputDir: z.string(), files: z.array(z.string()) }),
  z.object({ type: z.literal("cancelled"), outputDir: z.string(), files: z.array(z.string()) }),
  z.object({ type: z.literal("failed"), error: ApiErrorSchema }),
]);
export type JobEvent = z.infer<typeof JobEventSchema>;

/** GET /api/decks/:id/exports: what the export dialog needs, and the deck's job to reconnect to. */
export const ExportsInfoSchema = z.object({
  job: ExportJobSchema.nullable(),
  presets: z.array(z.object({ name: z.string(), width: z.number(), height: z.number(), use: z.string() })),
  defaults: z.object({
    preset: z.string(),
    format: z.enum(["png", "video"]),
    /** Set when configuration.yml names an output folder (workspace-relative). */
    outputDir: z.string().nullable(),
    /** Otherwise the folder is `${outputBase}/<preset>-<format>`. */
    outputBase: z.string(),
    duration: z.number().nullable(),
  }),
});
export type ExportsInfo = z.infer<typeof ExportsInfoSchema>;

export const TOKEN_HEADER = "x-flipbook-token";
export const TOKEN_META = "flipbook-token";
export const TOKEN_PLACEHOLDER = "__FLIPBOOK_TOKEN__";

// US-11: settings and the local LLM.
export const API_KEY_MASK = "••••";
const httpUrl = z
  .string()
  .trim()
  .url("Enter a full URL, such as http://127.0.0.1:11434/v1.")
  .refine((value) => /^https?:\/\//i.test(value), "Use an http:// or https:// URL.");
// US-19 (D29): the AI tasks that can each have their own model.
export const AI_TASKS = ["rewrite", "generate", "draft", "chat"] as const;
export type AiTask = (typeof AI_TASKS)[number];
/** How each task is named in Settings, AI panels and errors. */
export const AI_TASK_LABELS: Record<AiTask, string> = {
  rewrite: "Rewrite a slide",
  generate: "Generate a deck",
  draft: "Draft a kit piece",
  chat: "Chat",
};
const MODEL_ID = z.string().trim().min(1, "Pick a model.").max(200);
/** A model per AI task; a missing key uses the default `model`. */
export const TaskModelsSchema = z.object({
  rewrite: MODEL_ID.optional(),
  generate: MODEL_ID.optional(),
  draft: MODEL_ID.optional(),
  chat: MODEL_ID.optional(),
});
export type TaskModels = z.infer<typeof TaskModelsSchema>;
/** In PUT /api/settings: a model ID sets a task, null clears it, a key left out is kept. */
const TaskModelsPatchSchema = z
  .object({
    rewrite: MODEL_ID.nullable().optional(),
    generate: MODEL_ID.nullable().optional(),
    draft: MODEL_ID.nullable().optional(),
    chat: MODEL_ID.nullable().optional(),
  })
  .strict();
export type TaskModelsPatch = z.infer<typeof TaskModelsPatchSchema>;
export const LlmSettingsSchema = z.object({
  baseUrl: httpUrl,
  model: z.string().min(1).nullable(),
  /** Masked as "••••" in responses. */
  apiKey: z.string().nullable(),
  temperature: z.number().min(0).max(2),
  timeoutMs: z.number().int().min(5_000).max(600_000),
  maxRepairRounds: z.number().int().min(0).max(3),
  taskModels: TaskModelsSchema.optional(),
});
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;
// US-21 (D32, D34): paid providers, kept beside the local connection.
export const PROVIDER_KINDS = ["anthropic", "openai", "openai-compatible"] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;
/** How each kind is named in Settings → Providers. */
export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  "openai-compatible": "Other (OpenAI-compatible)",
};
/** localhost, 127.0.0.0/8 or ::1 (a URL hostname, with or without IPv6 brackets). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
/** A provider URL: https, or http only on loopback, so a key never crosses the network in clear. */
const providerUrl = httpUrl.refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || isLoopbackHost(url.hostname);
}, "Use an https:// URL (http:// only for a server on this machine).");
export const PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const PROVIDER_ID = z.string().regex(PROVIDER_ID_PATTERN, "Not a provider ID.");
const PROVIDER_LABEL = z.string().trim().min(1, "Enter a name.").max(40, "Use at most 40 characters.");
/** Spaces around a pasted key are trimmed. */
const PROVIDER_API_KEY = z.string().trim().min(1, "Enter the API key.").max(500, "That key is too long.");
export const ProviderSchema = z.object({
  /** Made by the server from the label, and never changed (task models point to it). */
  id: PROVIDER_ID,
  kind: ProviderKindSchema,
  label: PROVIDER_LABEL,
  /** Fixed for anthropic and openai; chosen by the user for openai-compatible. */
  baseUrl: providerUrl,
  /** Never returned by the API (see ProviderView). */
  apiKey: PROVIDER_API_KEY,
});
export type Provider = z.infer<typeof ProviderSchema>;
/** A provider as the API returns it: the key only as a hint such as "sk-…a1b2" (D34). */
export const ProviderViewSchema = ProviderSchema.omit({ apiKey: true }).extend({ apiKeyHint: z.string() });
export type ProviderView = z.infer<typeof ProviderViewSchema>;
/** POST /api/providers. `baseUrl` is required for openai-compatible and refused for the others. */
export const CreateProviderRequestSchema = z
  .object({
    kind: ProviderKindSchema,
    label: PROVIDER_LABEL.optional(),
    baseUrl: providerUrl.optional(),
    apiKey: PROVIDER_API_KEY,
  })
  .strict();
export type CreateProviderRequest = z.infer<typeof CreateProviderRequestSchema>;
/** PATCH /api/providers/:id. `baseUrl` only for openai-compatible. */
export const UpdateProviderRequestSchema = z
  .object({
    label: PROVIDER_LABEL.optional(),
    apiKey: PROVIDER_API_KEY.optional(),
    baseUrl: providerUrl.optional(),
  })
  .strict();
export type UpdateProviderRequest = z.infer<typeof UpdateProviderRequestSchema>;
/** Tokens as a provider reports them. */
export const UsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;
// US-23: the commit author Studio uses only when git config has none (passed with -c, never saved to git config).
export const GitAuthorSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100),
  email: z
    .string()
    .trim()
    .max(254)
    .regex(/^[^\s@<>]+@[^\s@<>]+$/, "Enter an email address, such as you@example.com."),
});
export type GitAuthor = z.infer<typeof GitAuthorSchema>;
export const SettingsSchema = z.object({
  version: z.literal(1),
  llm: LlmSettingsSchema.nullable(),
  lastWorkspace: z.string().nullable(),
  /** US-21: paid providers; missing means none. */
  providers: z.array(ProviderSchema).optional(),
  git: z.object({ author: GitAuthorSchema.optional() }).optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;
/** GET /api/settings: Settings with each provider as a ProviderView (keys never leave the server). */
export const SettingsViewSchema = SettingsSchema.extend({
  providers: z.array(ProviderViewSchema).optional(),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;
/** PUT /api/settings: a partial merge. `llm: null` removes the LLM; `apiKey: null` clears the key, leaving it out keeps it. */
export const SettingsPatchSchema = z
  .object({
    llm: LlmSettingsSchema.omit({ taskModels: true })
      .partial()
      .extend({ taskModels: TaskModelsPatchSchema.optional() })
      .strict()
      .nullable()
      .optional(),
    lastWorkspace: z.string().nullable().optional(),
    /** US-23: `author: null` forgets the saved author. */
    git: z.object({ author: GitAuthorSchema.nullable() }).strict().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

// US-21: /api/llm/models and /api/llm/test take a target in one of three forms.
/** A saved provider, used with its stored key. */
const SavedProviderTarget = z.object({ providerId: PROVIDER_ID });
/** A provider not saved yet. `baseUrl` only (and always) for openai-compatible. */
const NewProviderTarget = z.object({
  providerId: z.never().optional(),
  kind: ProviderKindSchema,
  baseUrl: providerUrl.optional(),
  apiKey: PROVIDER_API_KEY,
});
const LocalTarget = z.object({
  providerId: z.never().optional(),
  kind: z.never().optional(),
  baseUrl: httpUrl,
  /** Left out: the saved key is used. null: no key. */
  apiKey: z.string().nullable().optional(),
});
const newProviderBaseUrlRule = (value: { kind: ProviderKind; baseUrl?: string }, ctx: z.RefinementCtx) => {
  if (value.kind === "openai-compatible" && !value.baseUrl)
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter the service's base URL." });
  if (value.kind !== "openai-compatible" && value.baseUrl)
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "This provider's URL is fixed." });
};
export const LlmModelsRequestSchema = z.union([
  SavedProviderTarget,
  NewProviderTarget.superRefine(newProviderBaseUrlRule),
  LocalTarget,
]);
export type LlmModelsRequest = z.infer<typeof LlmModelsRequestSchema>;
export const LlmModelsResponseSchema = z.object({
  models: z.array(z.object({ id: z.string(), contextLength: z.number().optional() })),
});
const LLM_TEST_FIELDS = {
  model: z.string().min(1),
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
};
export const LlmTestRequestSchema = z.union([
  SavedProviderTarget.extend(LLM_TEST_FIELDS),
  NewProviderTarget.extend(LLM_TEST_FIELDS).superRefine(newProviderBaseUrlRule),
  LocalTarget.extend(LLM_TEST_FIELDS),
]);
export type LlmTestRequest = z.infer<typeof LlmTestRequestSchema>;
export const LlmTestResponseSchema = z.object({
  reply: z.string(),
  latencyMs: z.number(),
  /** US-21: tokens the provider reported for the test, or null. */
  usage: UsageSchema.nullable(),
});
export type LlmTestResponse = z.infer<typeof LlmTestResponseSchema>;

// US-12 to US-15: AI proposals.
/**
 * A slide ID as the server issues it: a manifest path inside the deck (folder decks) or `#<index>`
 * (single files). Absolute paths, backslashes and `..` segments are refused outright.
 */
export const SlideIdSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (id) =>
      /^#\d+$/.test(id) ||
      (!id.startsWith("/") && !id.includes("\\") && !id.split("/").includes("..") && !/^[a-z]:/i.test(id)),
    "Not a slide ID.",
  );
const OpId = z.string().min(1).max(40);
export const ProposalOpSchema = z.discriminatedUnion("kind", [
  z.object({
    id: OpId,
    kind: z.literal("updateSlide"),
    slideId: SlideIdSchema,
    draft: SlideDraftSchema,
    /** The slide as it was when the proposal was made (for the diff). */
    before: SlideDraftSchema.optional(),
    /** Blueprint violations of this slide with the draft applied. */
    violations: z.array(ViolationSchema).optional(),
  }),
  z.object({
    id: OpId,
    kind: z.literal("addSlide"),
    afterSlideId: SlideIdSchema.nullable(),
    draft: SlideDraftSchema,
  }),
  z.object({ id: OpId, kind: z.literal("deleteSlide"), slideId: SlideIdSchema }),
  z.object({
    id: OpId,
    kind: z.literal("moveSlide"),
    slideId: SlideIdSchema,
    toIndex: z.number().int().nonnegative(),
  }),
  z.object({
    id: OpId,
    kind: z.literal("writeKitFile"),
    kit: z.object({
      kind: KitKindSchema,
      name: z.string().max(60),
      scope: z.enum(["library", "deck"]),
      deckId: z.string().optional(),
    }),
    source: z.string().max(50 * 1024),
  }),
]);
export type ProposalOp = z.infer<typeof ProposalOpSchema>;
export const ProposalSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  deckId: z.string().nullable(),
  summary: z.string(),
  ops: z.array(ProposalOpSchema),
  /** File key → hash when the proposal was made (deck files as in DeckDetail.hashes; kits as kit:<kind>:<scope>:<name>). */
  baseHashes: z.record(z.string(), z.string().nullable()),
});
export type Proposal = z.infer<typeof ProposalSchema>;
export const ApplyProposalRequestSchema = z.object({ opIds: z.array(OpId).max(500) });
export const ApplyProposalResponseSchema = z.object({
  applied: z.array(z.string()),
  rejected: z.array(
    z.object({
      opId: z.string(),
      code: z.enum(["STALE_PROPOSAL", "KIT_INVALID", "VALIDATION_FAILED"]),
      message: z.string(),
    }),
  ),
  hashes: z.record(z.string(), z.string()),
});
export type ApplyProposalResponse = z.infer<typeof ApplyProposalResponseSchema>;

export const RewriteInstructionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shorten") }),
  z.object({ kind: z.literal("expand") }),
  z.object({ kind: z.literal("translate"), language: z.string().trim().min(1, "Pick a language.").max(60) }),
  z.object({ kind: z.literal("custom"), text: z.string().trim().min(1, "Say what to change.").max(2000) }),
]);
export type RewriteInstruction = z.infer<typeof RewriteInstructionSchema>;
export const RewriteRequestSchema = z.object({
  deckId: z.string(),
  slideId: SlideIdSchema,
  baseHash: Hash,
  instruction: RewriteInstructionSchema,
  /** A retry: the rule messages the previous proposal broke, so the model can fix them. */
  avoid: z.array(z.string().max(500)).max(20).optional(),
});
export type RewriteRequest = z.infer<typeof RewriteRequestSchema>;

// US-18: start a deck from an uploaded file (tech-spec D22-D25).
export const SOURCE_MAX_BYTES = 25 * 1024 * 1024;
export const SOURCE_EXTENSIONS = [".md", ".markdown", ".txt", ".docx"] as const;
export const SourceIdSchema = z.string().regex(/^[0-9a-f-]{36}$/, "Pick the file again.");
export const DroppedSchema = z.object({
  kind: z.enum(["image", "html", "linked-image", "relative-image"]),
  reason: z.enum(["type", "size", "limit", "not-embedded", "not-uploaded", "removed"]),
  count: z.number().int().positive(),
  /** An image format ("EMF") or a dropped href. */
  detail: z.string().optional(),
});
export type Dropped = z.infer<typeof DroppedSchema>;
export const SourceImageSchema = z.object({
  /** The name the source text uses for it: "image1.png". */
  id: z.string(),
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** A data: URI for images up to 256 kB, so the preview needs no extra route. */
  thumbnail: z.string().nullable(),
});
export const SourceDocumentSchema = z.object({
  sourceId: SourceIdSchema,
  fileName: z.string(),
  format: z.enum(["md", "txt", "docx"]),
  title: z.string(),
  chars: z.number().int().nonnegative(),
  sections: z.number().int().nonnegative(),
  /** The images that will be imported (checked like uploads, D19). */
  images: z.array(SourceImageSchema),
  dropped: z.array(DroppedSchema),
  expiresAt: z.string(),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export const ImportDeckRequestSchema = z.object({
  sourceId: SourceIdSchema,
  name: z.string().regex(DECK_NAME, "Use 1-60 lowercase letters, digits or dashes."),
  title: z.string().trim().min(1, "Use 1-120 characters.").max(120, "Use 1-120 characters."),
  group: z.string().trim().min(1).nullable(),
});
export type ImportDeckRequest = z.infer<typeof ImportDeckRequestSchema>;
export const ImportDeckResponseSchema = z.object({
  deckId: z.string(),
  dropped: z.array(DroppedSchema),
  violations: z.array(ViolationSchema),
});
export type ImportDeckResponse = z.infer<typeof ImportDeckResponseSchema>;

// US-13: generate a deck with AI.
export const GENERATE_TEXT_LIMIT = 200_000;
export const GenerateDeckRequestSchema = CreateDeckRequestSchema.extend({
  /** A topic to write about, or source text to turn into slides (checked for size before streaming). */
  source: z.union([
    z.object({ topic: z.string().trim().min(1, "Describe the topic.").max(2000) }).strict(),
    z.object({ text: z.string().trim().min(1, "Paste some text.") }).strict(),
    /** A file uploaded with POST /api/sources (US-18); the deck must be a folder (D25). */
    z.object({ sourceId: SourceIdSchema }).strict(),
  ]),
  language: z.string().trim().min(1).max(60).optional(),
});
export type GenerateDeckRequest = z.infer<typeof GenerateDeckRequestSchema>;
export const SaveAsRequestSchema = z.object({
  name: z.string().regex(DECK_NAME, "Use 1-60 lowercase letters, digits or dashes."),
});

/** The events of POST /api/ai/generate-deck, in order: slide…, repair…, then done or failed. */
export const GenerateSlideEventSchema = z.object({
  index: z.number().int().nonnegative(),
  draft: SlideDraftSchema,
});
export const GenerateRepairEventSchema = z.object({
  round: z.number().int().positive(),
  violations: z.array(ViolationSchema),
});
export const GenerateNoticeEventSchema = z.object({ message: z.string() });
export const GenerateDoneEventSchema = z.object({
  deckId: z.string(),
  violations: z.array(ViolationSchema),
  /** The model that ran (US-19). */
  model: z.string().optional(),
});
export const AiFailedEventSchema = z.object({ error: ApiErrorSchema });

// US-14: draft a kit piece with AI.
export const DraftKitRequestSchema = z.object({
  kind: KitKindSchema,
  name: z.string().trim().min(1, "Name it.").max(60),
  description: z.string().trim().min(1, "Describe what you want.").max(4000),
  /** Draft the deck's own presentation.css or blueprint.yml instead of a library kit. */
  deckId: z.string().optional(),
});
export type DraftKitRequest = z.infer<typeof DraftKitRequestSchema>;

// US-15: chat about the open deck.
export const ChatRequestSchema = z.object({
  deckId: z.string(),
  /** null, or an ID the server forgot (a restart), starts a new session. */
  sessionId: z.string().max(100).nullable(),
  message: z.string().trim().min(1, "Write a message.").max(8000),
  /** The slide open in the editor: its full text goes into the context. */
  slideId: SlideIdSchema.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export const ChatDoneEventSchema = z.object({
  sessionId: z.string(),
  /** The model that ran (US-19). */
  model: z.string().optional(),
});

// US-23: version history (tech-spec D36, D37, D43). A Version is one commit that touches the deck.
export const VersionSchema = z.object({
  sha: z.string(),
  /** The commit subject. */
  note: z.string(),
  author: z.string(),
  /** ISO-8601 UTC, the author date. */
  time: z.string(),
  /** Slides added, removed or modified versus the version before it. */
  slidesChanged: z.number().int().nonnegative(),
});
export type Version = z.infer<typeof VersionSchema>;
export const HistoryStateSchema = z.object({
  state: z.enum(["ready", "no-repo", "no-git", "unsupported"]),
  reason: z.string().nullable(),
  repoRoot: z.string().nullable(),
  canInit: z.object({ deck: z.boolean(), workspace: z.boolean() }),
  /** The deck's latest version, or null (no repo, or no version yet). */
  head: VersionSchema.nullable(),
  /** The deck has changes since `head`. */
  dirty: z.boolean(),
  /** Paths relative to the deck folder (or the single file's folder). */
  changes: z.array(z.object({ path: z.string(), status: z.enum(["added", "modified", "deleted"]) })),
  detached: z.boolean(),
});
export type HistoryState = z.infer<typeof HistoryStateSchema>;
export const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const VERSION_NOTE_MAX = 200;
export const VersionsQuerySchema = z.object({
  before: z.string().regex(SHA, "Not a version ID.").optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const VersionsResponseSchema = z.object({
  history: HistoryStateSchema,
  versions: z.array(VersionSchema),
  /** The `before` cursor for the next page, or null on the last page. */
  next: z.string().nullable(),
});
export type VersionsResponse = z.infer<typeof VersionsResponseSchema>;
export const SaveVersionRequestSchema = z.object({
  note: z
    .string()
    .max(VERSION_NOTE_MAX, `Use at most ${VERSION_NOTE_MAX} characters.`)
    .refine((note) => !/[\r\n]/.test(note), "Use one line.")
    .optional(),
});
export const SaveVersionResponseSchema = z.object({ version: VersionSchema, history: HistoryStateSchema });
export type SaveVersionResponse = z.infer<typeof SaveVersionResponseSchema>;
export const GitInitRequestSchema = z.object({ deckId: z.string(), at: z.enum(["deck", "workspace"]) });
export type GitInitRequest = z.infer<typeof GitInitRequestSchema>;
export const GitInitResponseSchema = z.object({ history: HistoryStateSchema });

// US-26: restore a whole deck from a version, or discard its changes (tech-spec D38, D42).
// Both are one undoable journal step; neither makes a commit or changes HEAD, refs or the index.
export const RestoreRequestSchema = z.object({ expectHead: z.string().regex(SHA, "Not a version ID.") });
export type RestoreRequest = z.infer<typeof RestoreRequestSchema>;
export const RestoreParamsSchema = z.object({ sha: z.string().regex(SHA, "Not a version ID.") });
export const RestoreResponseSchema = z.object({
  deck: DeckDetailSchema,
  history: HistorySchema,
  state: HistoryStateSchema,
  /** Version files left as they are: symlinks, submodules, hidden or very large files. */
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type RestoreResponse = z.infer<typeof RestoreResponseSchema>;
