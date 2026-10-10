import type { Metadata } from "next";
import { SideNav } from "@/components/shell/SideNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReqFlow",
  description: "From customer evidence to prioritized, PM-approved vehicle requirements.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex h-full antialiased">
        <SideNav />
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </body>
    </html>
  );
}
