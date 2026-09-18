import type { Metadata } from "next";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "./theme.ts";

export const metadata: Metadata = {
  title: "界核 / REALM",
  description: "多人叙事角色运行时——让世界持续记住每一次选择。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "界核 / REALM",
    description: "让世界持续记住每一次选择。",
    images: ["/og.png"],
    locale: "zh_CN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "界核 / REALM",
    description: "让世界持续记住每一次选择。",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首帧前初始化主题：避免 night 用户先闪浅色；SSR 不读 window。 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
