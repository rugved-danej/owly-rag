import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "../components/Providers";

export const metadata: Metadata = {
  title: "Owly RAG",
  description: "Local-first document Q&A and conversational assistant with Owly",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#141413] text-[#F4F3EE] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
