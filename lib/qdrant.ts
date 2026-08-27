import { QdrantClient } from "@qdrant/js-client-rest";
import type { Moment, MomentDraft, SearchResult } from "@/lib/types";
import {
  createEmbedding,
  getEmbeddingDimensions,
  normalizeForMultimodalSearch,
} from "@/lib/openai";

const collectionName = process.env.QDRANT_COLLECTION || "hitotoki_moments";
const usesCloudInference = process.env.QDRANT_INFERENCE_MODE === "cloud";
const cloudVectorSize = Number(process.env.QDRANT_VECTOR_SIZE || 512);
const imageModel = process.env.QDRANT_IMAGE_MODEL || "Qdrant/clip-ViT-B-32-vision";
const textModel = process.env.QDRANT_TEXT_MODEL || "Qdrant/clip-ViT-B-32-text";
let collectionReady: Promise<void> | undefined;

function getClient() {
  if (!process.env.QDRANT_URL) {
    throw new Error("QDRANT_URL が設定されていません。");
  }

  return new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY || undefined,
  });
}

async function ensureCollection() {
  if (!collectionReady) {
    collectionReady = (async () => {
      const client = getClient();
      const { exists } = await client.collectionExists(collectionName);

      if (!exists) {
        await client.createCollection(collectionName, {
          vectors: {
            size: usesCloudInference ? cloudVectorSize : getEmbeddingDimensions(),
            distance: "Cosine",
          },
        });
      }
    })().catch((error) => {
      collectionReady = undefined;
      throw error;
    });
  }

  return collectionReady;
}

function payloadToMoment(payload: Record<string, unknown>, fallbackId: string | number): Moment {
  return {
    id: typeof payload.id === "string" ? payload.id : String(fallbackId),
    timestamp: String(payload.timestamp),
    source: payload.source === "parent" ? "parent" : "camera",
    description: String(payload.description),
    imageUrl: typeof payload.imageUrl === "string" ? payload.imageUrl : undefined,
    metadata:
      payload.metadata && typeof payload.metadata === "object"
        ? (payload.metadata as Record<string, unknown>)
        : undefined,
  };
}

function searchableText(moment: MomentDraft) {
  const recordedAt = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(moment.timestamp));

  return `${moment.description}\n記録日時: ${recordedAt}\n記録元: ${moment.source === "camera" ? "カメラ" : "親のメモ"}`;
}

export async function saveMoment(draft: MomentDraft, imageDataUrl?: string): Promise<Moment> {
  await ensureCollection();
  const client = getClient();
  const id = crypto.randomUUID();
  const moment: Moment = { id, ...draft };
  let vector;

  if (usesCloudInference) {
    if (draft.source === "camera") {
      if (!imageDataUrl) throw new Error("カメラMomentの画像がありません。");
      vector = {
        image: imageDataUrl.replace(/^data:image\/[^;]+;base64,/, ""),
        model: imageModel,
      };
    } else {
      vector = {
        text: await normalizeForMultimodalSearch(searchableText(draft)),
        model: textModel,
      };
    }
  } else {
    vector = await createEmbedding(searchableText(draft));
  }

  await client.upsert(collectionName, {
    wait: true,
    points: [{ id, vector, payload: moment }],
  });

  return moment;
}

export async function listMoments(): Promise<Moment[]> {
  await ensureCollection();
  const client = getClient();
  const result = await client.scroll(collectionName, {
    limit: 50,
    with_payload: true,
    with_vector: false,
  });

  return result.points
    .filter((point) => point.payload)
    .map((point) => payloadToMoment(point.payload!, point.id))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

export async function searchMoments(query: string): Promise<SearchResult[]> {
  await ensureCollection();
  const client = getClient();
  const vector = usesCloudInference
    ? { text: await normalizeForMultimodalSearch(query), model: textModel }
    : await createEmbedding(query);
  const results = await client.query(collectionName, {
    query: vector,
    limit: 8,
    with_payload: true,
    score_threshold: 0.15,
  });

  return results.points
    .filter((result) => result.payload)
    .map((result) => ({
      ...payloadToMoment(result.payload!, result.id),
      score: result.score,
    }));
}
