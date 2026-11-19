import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AI_TASKS,
  API_KEY_MASK,
  type TaskModels,
  type TaskModelsPatch,
  SettingsSchema,
  type LlmSettings,
  type Settings,
  type SettingsPatch,
  type Provider,
  type ProviderView,
  type SettingsView,
} from "../shared/api.js";
import { paidModel } from "../shared/taskModels.js";
import { StudioError } from "./errors.js";
import { apiKeyHint } from "./llm/keys.js";

/** The task models that point to a paid provider, or undefined when there are none (US-24). */
function paidOnly(taskModels: TaskModels | undefined): TaskModels | undefined {
  const paid = Object.fromEntries(
    Object.entries(taskModels ?? {}).filter(([, value]) => paidModel(value)),
  ) as TaskModels;
  return Object.keys(paid).length ? paid : undefined;
}

export const DEFAULT_SETTINGS: Settings = { version: 1, llm: null, lastWorkspace: null };
export const LLM_DEFAULTS: Omit<LlmSettings, "baseUrl"> = {
  model: null,
  apiKey: null,
  temperature: 0.2,
  timeoutMs: 60_000,
  maxRepairRounds: 1,
};

/**
 * The OS config folder for Studio: `FLIPBOOK_STUDIO_CONFIG_DIR` when set (tests), else
 * `~/Library/Application Support/flipbook-studio` on macOS, `%APPDATA%\flipbook-studio` on
 * Windows, and `$XDG_CONFIG_HOME/flipbook-studio` (default `~/.config`) elsewhere.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.FLIPBOOK_STUDIO_CONFIG_DIR?.trim()) return path.resolve(env.FLIPBOOK_STUDIO_CONFIG_DIR);
  const home = os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "flipbook-studio");
  if (platform === "win32")
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "flipbook-studio");
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "flipbook-studio");
}

/** A provider as the API returns it: no key, only its hint (US-21, D34). */
export function providerView({ apiKey, ...provider }: Provider): ProviderView {
  return { ...provider, apiKeyHint: apiKeyHint(apiKey) };
}

/** Settings as the API returns them: the apiKey masked, and providers as ProviderViews. */
export function maskSettings(settings: Settings): SettingsView {
  const view: SettingsView = settings.providers
    ? { ...settings, providers: settings.providers.map(providerView) }
    : (settings as SettingsView);
  if (!view.llm) return view;
  return { ...view, llm: { ...view.llm, apiKey: view.llm.apiKey ? API_KEY_MASK : null } };
}

/** One settings.json, read at startup and written atomically (folder 0700, file 0600). */
export class SettingsStore {
  private settings: Settings = DEFAULT_SETTINGS;
  /** Why the file can't be written (an unknown version), or null. */
  locked: string | null = null;
  readonly file: string;

  private constructor(
    readonly dir: string,
    private readonly log: (line: string) => void,
  ) {
    this.file = path.join(dir, "settings.json");
  }

  static async open(dir = configDir(), log: (line: string) => void = console.warn): Promise<SettingsStore> {
    const store = new SettingsStore(dir, log);
    await store.load();
    return store;
  }

  private async load() {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.backUp("is not valid JSON");
    }
    const version = (parsed as { version?: unknown } | null)?.version;
    if (version !== 1) {
      this.locked = `${this.file} has settings version ${JSON.stringify(version)}, which this Studio doesn't know. It won't be changed; update Studio or move the file away.`;
      this.log(`Warning: ${this.locked} Starting with default settings.`);
      return;
    }
    const result = SettingsSchema.safeParse(parsed);
    if (!result.success) return this.backUp("doesn't match the settings format");
    this.settings = result.data;
  }

  private async backUp(why: string) {
    await fs.copyFile(this.file, `${this.file}.bak`);
    await fs.rm(this.file, { force: true });
    this.log(
      `Warning: ${this.file} ${why}. It was saved as settings.json.bak; starting with default settings.`,
    );
  }

  current(): Settings {
    return this.settings;
  }

  /** Applies a partial update (see SettingsPatchSchema) and writes the file. */
  async update(patch: SettingsPatch): Promise<Settings> {
    if (this.locked) throw new StudioError(409, "SETTINGS_UNSUPPORTED", this.locked);
    const next: Settings = { ...this.settings };
    if (patch.lastWorkspace !== undefined) next.lastWorkspace = patch.lastWorkspace;
    if (patch.llm === null) {
      // US-24: removing the local LLM clears only the local task models; paid ones are kept aside.
      next.llm = null;
      const paid = paidOnly(this.settings.llm?.taskModels ?? this.settings.paidTaskModels);
      if (paid) next.paidTaskModels = paid;
      else delete next.paidTaskModels;
    } else if (patch.llm) {
      const { apiKey, taskModels, ...rest } = patch.llm;
      if (taskModels) this.checkProviders(taskModels);
      const kept = this.settings.paidTaskModels;
      const base =
        this.settings.llm ??
        (rest.baseUrl
          ? { baseUrl: rest.baseUrl, ...LLM_DEFAULTS, ...(kept ? { taskModels: kept } : {}) }
          : null);
      if (!base)
        throw new StudioError(422, "VALIDATION_FAILED", "Set a base URL to connect an LLM.", {
          details: { fields: [{ path: "llm.baseUrl", message: "Required." }] },
        });
      next.llm = { ...base, ...rest };
      // Left out, or the mask sent back: keep the key. null: clear it.
      if (apiKey !== undefined && apiKey !== API_KEY_MASK) next.llm.apiKey = apiKey;
      // US-19 (D29): merge task models per key; null clears one, and an empty map is no map.
      if (taskModels !== undefined) {
        const merged: TaskModels = { ...(base.taskModels ?? {}) };
        for (const task of AI_TASKS) {
          const value = taskModels[task];
          if (value === null) delete merged[task];
          else if (value !== undefined) merged[task] = value;
        }
        if (Object.keys(merged).length) next.llm.taskModels = merged;
        else delete next.llm.taskModels;
      }
      delete next.paidTaskModels;
    }
    // US-23: the commit author used only when git config has none; null forgets it.
    if (patch.git) {
      if (patch.git.author) next.git = { ...next.git, author: patch.git.author };
      else delete next.git;
    }
    const valid = SettingsSchema.parse(next);
    await this.write(valid);
    this.settings = valid;
    return valid;
  }

  /** US-24: a task model may only name a provider that exists (a removed one is kept, but not set anew). */
  private checkProviders(taskModels: TaskModelsPatch) {
    const known = new Set((this.settings.providers ?? []).map((provider) => provider.id));
    const fields = AI_TASKS.flatMap((task) => {
      const paid = paidModel(taskModels[task]);
      return paid && !known.has(paid.provider)
        ? [{ path: `llm.taskModels.${task}.provider`, message: `There's no provider "${paid.provider}".` }]
        : [];
    });
    if (fields.length)
      throw new StudioError(422, "VALIDATION_FAILED", fields[0]!.message, { details: { fields } });
  }

  /** US-21: replaces the paid providers and writes the file. An empty list leaves no `providers` key. */
  async setProviders(providers: Provider[]): Promise<Settings> {
    if (this.locked) throw new StudioError(409, "SETTINGS_UNSUPPORTED", this.locked);
    const next: Settings = { ...this.settings, providers };
    if (!providers.length) delete next.providers;
    const valid = SettingsSchema.parse(next);
    await this.write(valid);
    this.settings = valid;
    return valid;
  }

  /** Every stored API key (the local one and each provider's), for the scrubber. */
  apiKeys(): string[] {
    return [this.settings.llm?.apiKey, ...(this.settings.providers ?? []).map((p) => p.apiKey)].filter(
      (key): key is string => Boolean(key),
    );
  }

  private async write(settings: Settings) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.dir, 0o700);
    const temp = `${this.file}.${process.pid}.tmp`;
    const handle = await fs.open(temp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temp, this.file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    if (process.platform !== "win32") await fs.chmod(this.file, 0o600);
  }
}
