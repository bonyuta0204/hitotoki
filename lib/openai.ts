import OpenAI from "openai";

const EMBEDDING_DIMENSIONS = 1536;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY が設定されていません。");
  }

  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export function getEmbeddingDimensions() {
  return EMBEDDING_DIMENSIONS;
}

export async function describeCameraMoment(imageDataUrl: string) {
  const response = await getClient().responses.create({
    model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
    instructions:
      "あなたは家族の思い出を短く記録するアシスタントです。画像内で実際に見える人物の動作、表情、物だけを、温かく自然な日本語1文（60文字以内）で説明してください。人物の身元、年齢、健康状態は推測しないでください。説明文だけを返してください。",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "この瞬間に起きていることを、あとから意味で検索しやすい言葉で記録してください。",
          },
          {
            type: "input_image",
            image_url: imageDataUrl,
            detail: "low",
          },
        ],
      },
    ],
    max_output_tokens: 100,
  });

  const description = response.output_text.trim();
  if (!description) {
    throw new Error("画像の説明を生成できませんでした。");
  }

  return description;
}

export async function normalizeForMultimodalSearch(text: string) {
  if (!/[^\x00-\x7F]/.test(text)) return text;

  try {
    const response = await getClient().responses.create({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
      instructions:
        "Convert the input into one concise English visual-search phrase. Preserve actions, objects, expressions, amounts, and feeding/care meaning. Return only the phrase.",
      input: text,
      max_output_tokens: 60,
    });

    return response.output_text.trim() || text;
  } catch (error) {
    console.warn("Search text normalization failed; using the original text.", error);
    return text;
  }
}

export async function createEmbedding(text: string) {
  const response = await getClient().embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return response.data[0].embedding;
}
