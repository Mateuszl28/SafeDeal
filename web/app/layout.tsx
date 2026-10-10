import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { WalletProvider } from "@/lib/wallet";
import { NotificationsProvider } from "@/components/Notifications";
import { DemoGuide } from "@/components/DemoGuide";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

const sans = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-sans", display: "swap" });
const display = Space_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "SafeDeal",
  description: "Buy from strangers without risk — blockchain escrow with delivery oracles and arbitration.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body>
        <WalletProvider>
          <NotificationsProvider>
          <div className="wrap">
            <Header />
            <main>{children}</main>
            <DemoGuide />
            <footer className="muted">
              <span className="footer-brand">◆ SafeDeal</span> The money is held by code, not a middleman. Every state has a deadline — nobody can freeze
              funds by disappearing. <span className="footer-chain">Built on Solana</span>
            </footer>
          </div>
          </NotificationsProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
