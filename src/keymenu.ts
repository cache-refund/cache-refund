import type { Readable } from "node:stream";

export type FinalAction = "copy-image" | "copy-report" | "show-paths" | "x" | "bluesky" | "linkedin" | "quit";

interface RawReadable extends Readable {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

function actionFor(chunk: Buffer): FinalAction | null {
  const key = chunk.toString("utf8");
  if (key === "\r" || key === "\n") return "copy-image";
  if (key === "r" || key === "R") return "copy-report";
  if (key === "s" || key === "S") return "show-paths";
  if (key === "x" || key === "X") return "x";
  if (key === "b" || key === "B") return "bluesky";
  if (key === "l" || key === "L") return "linkedin";
  if (key === "q" || key === "Q" || key === "\u001b" || key === "\u0003") return "quit";
  return null;
}

export function readFinalActionKey(input: RawReadable): Promise<FinalAction> {
  const wasRaw = input.isRaw === true;
  input.setRawMode?.(true);
  input.resume();
  return new Promise((resolve) => {
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onClose);
      input.off("error", onClose);
      input.setRawMode?.(wasRaw);
      input.pause();
    };
    const finish = (action: FinalAction) => {
      cleanup();
      resolve(action);
    };
    const onClose = () => finish("quit");
    const onData = (chunk: Buffer | string) => {
      const action = actionFor(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (action === null) return;
      finish(action);
    };
    input.on("data", onData);
    input.once("end", onClose);
    input.once("error", onClose);
  });
}
