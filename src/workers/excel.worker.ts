import { parseTabularFile } from "../lib/tabular-parser";

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  try {
    const { file } = e.data;
    if (!file) {
      throw new Error("Worker did not receive a valid file object.");
    }
    const result = await parseTabularFile(file);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};
