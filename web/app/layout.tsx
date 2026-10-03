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
  description: "Kupuj od obcych bez ryzyka — escrow na blockchainie z oracle doręczeń i arbitrażem.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl" className={`${sans.variable} ${display.variable}`}>
      <body>
        <WalletProvider>
          <NotificationsProvider>
          <div className="wrap">
            <Header />
            <main>{children}</main>
            <DemoGuide />
            <footer className="muted">
              <span className="footer-brand">◆ SafeDeal</span> Pieniądze trzyma kod, nie pośrednik. Każdy stan ma deadline — nikt nie zamrozi
              środków, znikając. <span className="footer-chain">Zbudowane na Solanie</span>
            </footer>
          </div>
          </NotificationsProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
