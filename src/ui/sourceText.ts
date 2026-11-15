import type { Dropped } from "../shared/api";

// US-18: how the "From a file" preview words what it read and left out. Pure, so it is unit-tested.

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** One dropped item as a sentence for the preview. */
export function droppedText(item: Dropped): string {
  switch (`${item.kind}:${item.reason}`) {
    case "image:type":
      return `${plural(item.count, "image")} in ${item.detail ?? "an unsupported"} format`;
    case "image:size":
      return `${plural(item.count, "image")} over 8 MB`;
    case "image:limit":
      return `${plural(item.count, "image")} past the first 50`;
    case "linked-image:not-embedded":
      return `${plural(item.count, "linked image")} not stored in the file`;
    case "relative-image:not-uploaded":
      return `${plural(item.count, "image link")} to a file that wasn't uploaded${item.detail ? ` (${item.detail})` : ""}`;
    case "html:removed":
      return `${plural(item.count, "piece")} of raw HTML`;
    default:
      return `${plural(item.count, "item")} (${item.kind})`;
  }
}
