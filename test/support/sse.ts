/** Reads a Server-Sent Events response into its events. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read any event shape
export async function sseEvents(response: Response): Promise<{ event: string; data: any }[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}
