import { NextResponse } from "next/server";

export function errorResponse(error: unknown, fallback: string) {
  console.error(error);
  const message = error instanceof Error ? error.message : fallback;

  return NextResponse.json({ error: message }, { status: 500 });
}
