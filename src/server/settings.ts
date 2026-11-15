import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AI_TASKS,
  API_KEY_MASK,
  type TaskModels,
  SettingsSchema,
  type LlmSettings,
  type Settings,
  type SettingsPatch,
} from "../shared/api.js";
import { StudioError } from "./errors.js";

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

/** Settings as the API returns them: the apiKey masked. */
export function maskSettings(settings: Settings): Settings {
  if (!settings.llm) return settings;
  return { ...settings, llm: { ...settings.llm, apiKey: settings.llm.apiKey ? API_KEY_MASK : null } };
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
    if (patch.llm === null) next.llm = null;
    else if (patch.llm) {
      const { apiKey, taskModels, ...rest } = patch.llm;
      const base = this.settings.llm ?? (rest.baseUrl ? { baseUrl: rest.baseUrl, ...LLM_DEFAULTS } : null);
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
    }
    const valid = SettingsSchema.parse(next);
    await this.write(valid);
    this.settings = valid;
    return valid;
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
