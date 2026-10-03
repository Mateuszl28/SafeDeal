import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { WalletProvider } from "@/lib/wallet";
import { NotificationsProvider } from "@/components/Notifications";
import { DemoGuide } from "@/components/DemoGuide";
import "./globals.css";

export const metadata: Metadata = {
  title: "SafeDeal",
  description: "Kupuj od obcych bez ryzyka — escrow na blockchainie z oracle doręczeń i arbitrażem.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body>
        <WalletProvider>
          <NotificationsProvider>
          <div className="wrap">
            <Header />
            <main>{children}</main>
            <DemoGuide />
            <footer className="muted">
              Pieniądze trzyma kod, nie pośrednik. Każdy stan ma deadline — nikt nie zamrozi środków, znikając.
            </footer>
          </div>
          </NotificationsProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
