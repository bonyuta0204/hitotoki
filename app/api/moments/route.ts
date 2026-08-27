import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { describeCameraMoment } from "@/lib/openai";
import { listMoments, saveMoment } from "@/lib/qdrant";
import type { MomentDraft } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreateMomentBody =
  | { kind: "note"; description: string }
  | { kind: "camera"; imageDataUrl: string };

async function persistCapture(imageDataUrl: string) {
  const match = imageDataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!match) throw new Error("画像データの形式が正しくありません。");

  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength > 6 * 1024 * 1024) {
    throw new Error("画像が大きすぎます。");
  }

  const fileName = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const uploadDirectory = path.join(process.cwd(), "public", "uploads");
  await mkdir(uploadDirectory, { recursive: true });
  await writeFile(path.join(uploadDirectory, fileName), bytes);

  return {
    imageUrl: `/uploads/${fileName}`,
    filePath: path.join(uploadDirectory, fileName),
  };
}

export async function GET() {
  try {
    return NextResponse.json({ moments: await listMoments() });
  } catch (error) {
    return errorResponse(error, "記憶を読み込めませんでした。");
  }
}

export async function POST(request: Request) {
  let persistedFilePath: string | undefined;

  try {
    const body = (await request.json()) as CreateMomentBody;
    const timestamp = new Date().toISOString();
    let draft: MomentDraft;

    if (body.kind === "note") {
      const description = body.description?.trim();
      if (!description) {
        return NextResponse.json({ error: "記録する内容を入力してください。" }, { status: 400 });
      }
      if (description.length > 500) {
        return NextResponse.json({ error: "メモは500文字以内で入力してください。" }, { status: 400 });
      }

      draft = {
        timestamp,
        source: "parent",
        description,
      };
    } else if (body.kind === "camera" && body.imageDataUrl) {
      const description = await describeCameraMoment(body.imageDataUrl);
      const capture = await persistCapture(body.imageDataUrl);
      persistedFilePath = capture.filePath;
      draft = {
        timestamp,
        source: "camera",
        description,
        imageUrl: capture.imageUrl,
      };
    } else {
      return NextResponse.json({ error: "Momentの形式が正しくありません。" }, { status: 400 });
    }

    const moment = await saveMoment(
      draft,
      body.kind === "camera" ? body.imageDataUrl : undefined,
    );
    return NextResponse.json({ moment }, { status: 201 });
  } catch (error) {
    if (persistedFilePath) {
      await unlink(persistedFilePath).catch(() => undefined);
    }
    return errorResponse(error, "Momentを保存できませんでした。");
  }
}
