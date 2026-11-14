import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ASSET_EXTENSIONS, type ApiError, type AssetUse, type DeckAsset } from "../../shared/api";
import { ApiRequestError, assetUrl, deleteAsset, listAssets, uploadAsset } from "../api";
import { formatBytes } from "../images";
import { ErrorNotice } from "./Shell";

const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: String(error) };

export const assetsKey = (deckId: string) => ["assets", deckId] as const;

/** Uploads files one by one; returns the stored assets and the per-file errors. */
export async function uploadFiles(
  deckId: string,
  files: File[],
): Promise<{ uploaded: DeckAsset[]; failed: { name: string; error: ApiError }[] }> {
  const uploaded: DeckAsset[] = [];
  const failed: { name: string; error: ApiError }[] = [];
  for (const file of files) {
    try {
      uploaded.push((await uploadAsset(deckId, file)).asset);
    } catch (error) {
      failed.push({ name: file.name, error: asApiError(error) });
    }
  }
  return { uploaded, failed };
}

function UploadErrors({ failed }: { failed: { name: string; error: ApiError }[] }) {
  if (!failed.length) return null;
  return (
    <ul className="upload-errors" role="alert" data-testid="upload-errors">
      {failed.map(({ name, error }) => (
        <li key={name}>
          <strong>{name}</strong>: {error.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * The deck's images (US-16). "manage" (deck screen) uploads and deletes; "pick" (slide editor)
 * also uploads and calls `onPick` with the chosen image.
 */
export function ImagesPanel({
  deckId,
  mode,
  selected,
  onPick,
}: {
  deckId: string;
  mode: "manage" | "pick";
  selected?: string | null;
  onPick?: (asset: DeckAsset) => void;
}) {
  const queryClient = useQueryClient();
  const assets = useQuery({ queryKey: assetsKey(deckId), queryFn: () => listAssets(deckId) });
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [failed, setFailed] = useState<{ name: string; error: ApiError }[]>([]);
  const [confirm, setConfirm] = useState<{ path: string; usedBy: AssetUse[] } | null>(null);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: assetsKey(deckId) });

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    const result = await uploadFiles(deckId, files);
    setUploading(false);
    setFailed(result.failed);
    await refresh();
    if (mode === "pick" && result.uploaded.length) onPick?.({ ...result.uploaded.at(-1)! });
  };

  const remove = async (asset: DeckAsset, force: boolean) => {
    setDeleteError(null);
    if (!force && asset.usedBy.length) {
      setConfirm({ path: asset.path, usedBy: asset.usedBy });
      return;
    }
    try {
      await deleteAsset(deckId, asset.path, force);
      setConfirm(null);
    } catch (error) {
      const apiError = asApiError(error);
      // Someone started using it since the list loaded: ask, with the server's list.
      if (apiError.code === "ASSET_IN_USE")
        setConfirm({ path: asset.path, usedBy: (apiError.details?.usedBy as AssetUse[]) ?? [] });
      else setDeleteError(apiError);
    }
    await refresh();
  };

  const list = assets.data?.assets ?? [];
  return (
    <section className="images-panel" aria-label="Images" data-testid="images-panel">
      <div className="images-head">
        <button type="button" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? "Uploading…" : "Upload images"}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Image files"
          accept={ASSET_EXTENSIONS.join(",")}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void upload(files);
          }}
        />
        <span className="muted">PNG, JPEG, GIF, WebP or SVG, up to 8 MB each.</span>
      </div>
      <UploadErrors failed={failed} />
      {deleteError ? <ErrorNotice error={deleteError} /> : null}
      {assets.isError ? <ErrorNotice error={asApiError(assets.error)} /> : null}
      {assets.isPending ? <p className="muted">Loading images…</p> : null}
      {assets.isSuccess && list.length === 0 ? (
        <p className="muted" data-testid="images-empty">
          No images yet. Upload one, or drop an image into a slide's Markdown.
        </p>
      ) : null}
      <ul className="image-grid">
        {list.map((asset) => {
          const name = asset.path.replace(/^assets\//, "");
          return (
            <li
              key={asset.path}
              className={`image-card${selected === asset.path ? " selected" : ""}`}
              data-testid="image-card"
              data-path={asset.path}
            >
              <img src={assetUrl(deckId, asset.path)} alt="" loading="lazy" />
              <p className="image-name" title={asset.path}>
                {name}
              </p>
              <p className="muted">
                {formatBytes(asset.bytes)}
                {asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ""}
              </p>
              <p className="muted" data-testid="image-usage">
                {asset.usedBy.length
                  ? `Used by ${asset.usedBy.map((use) => use.label).join(", ")}`
                  : "Not used"}
              </p>
              <div className="image-actions">
                {mode === "pick" ? (
                  <button
                    type="button"
                    className={selected === asset.path ? "primary" : undefined}
                    aria-pressed={selected === asset.path}
                    onClick={() => onPick?.(asset)}
                  >
                    {selected === asset.path ? "Chosen" : "Choose"}
                  </button>
                ) : (
                  <button type="button" className="danger" onClick={() => void remove(asset, false)}>
                    Delete <span className="visually-hidden">{name}</span>
                  </button>
                )}
              </div>
              {confirm?.path === asset.path ? (
                <div className="image-confirm" role="alertdialog" aria-label={`Delete ${name}?`}>
                  <p>{name} is used by:</p>
                  <ul data-testid="image-used-by">
                    {confirm.usedBy.map((use) => (
                      <li key={`${use.deckId}:${use.slideId ?? "theme"}`}>{use.label}</li>
                    ))}
                  </ul>
                  <p className="muted">Those slides will show a broken image.</p>
                  <button type="button" className="danger" onClick={() => void remove(asset, true)}>
                    Delete anyway
                  </button>
                  <button type="button" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
