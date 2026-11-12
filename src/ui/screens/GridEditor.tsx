import { useRef, useState } from "react";
import { nudge, spanCells, type Region } from "../../shared/templateFields";

const CELLS = [1, 2, 3].flatMap((row) => [1, 2, 3].map((column) => ({ column, row })));
const inside = (region: Region, cell: { column: number; row: number }) =>
  cell.column >= region.column &&
  cell.column < region.column + region.width &&
  cell.row >= region.row &&
  cell.row < region.row + region.height;

/**
 * A 3×3 grid for picking a template's region. Drag across cells to select a rectangle; with the
 * grid focused, arrows move the region and Shift plus arrows resize it. Standalone: value/onChange.
 */
export function GridEditor({
  value,
  onChange,
  label = "Template region",
}: {
  value: Region;
  onChange: (region: Region) => void;
  label?: string;
}) {
  const anchor = useRef<{ column: number; row: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const cellAt = (event: React.PointerEvent) => {
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-cell]");
    if (!target) return null;
    const [column, row] = target.dataset.cell!.split(",").map(Number) as [number, number];
    return { column, row };
  };

  return (
    <div
      className="grid-editor"
      role="group"
      aria-label={`${label}: column ${value.column}, row ${value.row}, ${value.width} wide, ${value.height} high`}
      aria-describedby="grid-help"
      tabIndex={0}
      data-testid="grid-editor"
      onKeyDown={(event) => {
        if (!event.key.startsWith("Arrow")) return;
        event.preventDefault();
        onChange(nudge(value, event.key, event.shiftKey));
      }}
      onPointerDown={(event) => {
        const cell = cellAt(event);
        if (!cell) return;
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        anchor.current = cell;
        setDragging(true);
        onChange(spanCells(cell, cell));
      }}
      onPointerMove={(event) => {
        if (!dragging || !anchor.current) return;
        const cell = cellAt(event);
        if (cell) onChange(spanCells(anchor.current, cell));
      }}
      onPointerUp={() => {
        anchor.current = null;
        setDragging(false);
      }}
    >
      {CELLS.map((cell) => (
        <div
          key={`${cell.column},${cell.row}`}
          data-cell={`${cell.column},${cell.row}`}
          className={inside(value, cell) ? "grid-cell selected" : "grid-cell"}
          aria-hidden="true"
        />
      ))}
      <p id="grid-help" className="sr-only">
        Drag across cells to select. Arrow keys move the region; Shift and arrow keys resize it.
      </p>
    </div>
  );
}
