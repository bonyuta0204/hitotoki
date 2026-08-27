import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { searchMoments } from "@/lib/qdrant";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { query } = (await request.json()) as { query?: string };
    const normalizedQuery = query?.trim();

    if (!normalizedQuery) {
      return NextResponse.json({ error: "探したいことを入力してください。" }, { status: 400 });
    }

    const moments = await searchMoments(normalizedQuery);
    return NextResponse.json({ moments });
  } catch (error) {
    return errorResponse(error, "記憶を探せませんでした。");
  }
}
