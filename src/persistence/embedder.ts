// E5 model — every input MUST carry a "query: " or "passage: " prefix.
// Swapping models requires updating embedText to match the new model's prefix convention.
//
// @huggingface/transformers is imported dynamically inside getEmbedder() so that
// onnxruntime-node (a heavy native module) is only loaded when embedText is first
// called, not on CLI startup for modes that never touch the embedder (chat, cron, …).
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL = "Xenova/multilingual-e5-small";
let instancePromise: Promise<FeatureExtractionPipeline> | null = null;

const getEmbedder = (): Promise<FeatureExtractionPipeline> => {
  if (!instancePromise) {
    // Dynamic import: defers native onnxruntime-node load until first use.
    instancePromise = import("@huggingface/transformers")
      .then(({ pipeline }) => pipeline("feature-extraction", MODEL))
      .catch((err: unknown) => {
        instancePromise = null; // allow retry on next call
        throw err;
      });
  }
  return instancePromise;
};

export const embedText = async (
  text: string,
  kind: "query" | "passage",
): Promise<Float32Array> => {
  const embedder = await getEmbedder();
  const output = await embedder(`${kind}: ${text}`, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as ArrayLike<number>);
};
