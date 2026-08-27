import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { saveMoment } from "@/lib/qdrant";

export const runtime = "nodejs";

const DEFAULT_ASR_URL = "https://api.shisa.ai/asr/srt/audio_llm";
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

type ShisaAsrResponse = {
  text?: string;
  language?: string;
  confidence?: number;
  error?: string;
};

export async function POST(request: Request) {
  try {
    if (!process.env.SHISA_API_KEY) {
      throw new Error("SHISA_API_KEY が設定されていません。");
    }

    const { audioDataUrl } = (await request.json()) as { audioDataUrl?: string };
    const match = audioDataUrl?.match(/^data:audio\/wav(?:;[^,]*)?;base64,(.+)$/);
    if (!match) {
      return NextResponse.json({ error: "WAV音声の形式が正しくありません。" }, { status: 400 });
    }

    const audio = match[1];
    const audioBytes = Buffer.byteLength(audio, "base64");
    if (audioBytes === 0 || audioBytes > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: "音声は30秒以内で記録してください。" }, { status: 400 });
    }

    const response = await fetch(process.env.SHISA_ASR_URL || DEFAULT_ASR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SHISA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio,
        language: "ja",
        hotwords: ["ミルク", "おむつ", "寝返り", "はいはい", "Hitotoki"],
      }),
    });
    const result = (await response.json().catch(() => ({}))) as ShisaAsrResponse;

    if (!response.ok) {
      throw new Error(result.error || `Shisa ASRへの接続に失敗しました。(${response.status})`);
    }

    const transcript = result.text?.trim();
    if (!transcript) {
      return NextResponse.json({ error: "言葉を聞き取れませんでした。" }, { status: 422 });
    }

    const moment = await saveMoment({
      timestamp: new Date().toISOString(),
      source: "parent",
      description: transcript,
      metadata: {
        capture: "voice",
        provider: "shisa",
        language: result.language,
        confidence: result.confidence,
      },
    });

    return NextResponse.json({ moment }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "声のMomentを保存できませんでした。");
  }
}
