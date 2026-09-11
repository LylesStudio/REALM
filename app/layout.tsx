import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
