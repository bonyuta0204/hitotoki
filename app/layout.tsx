import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hitotoki — ひととき",
  description: "赤ちゃんとの毎日を、あとから言葉で見つけられる記憶に。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
