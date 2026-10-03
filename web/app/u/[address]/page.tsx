"use client";

import { useParams } from "next/navigation";
import { DealList, useAllDeals } from "@/components/DealList";
import { ProfileSummary } from "@/components/Profile";
import { ProfileReviews } from "@/components/Reviews";
import { isAddress, sameAddr } from "@/lib/format";
import type { Address } from "@/lib/contracts";
import { useWallet } from "@/lib/wallet";

export default function ProfilePage() {
  const { address } = useParams<{ address: string }>();
  const w = useWallet();
  const deals = useAllDeals();

  if (!isAddress(address)) return <p>Nieprawidłowy adres.</p>;
  if (!w.deployment) return null;
  const addr = address as Address;

  return (
    <div className="grid">
      <ProfileSummary address={addr} deals={deals} />
      <ProfileReviews address={addr} />
      <DealList title="Sprzedaje" rows={deals.filter((d) => sameAddr(d.seller, addr))} empty="Brak sprzedaży." />
      <DealList title="Kupuje" rows={deals.filter((d) => sameAddr(d.buyer, addr))} empty="Brak zakupów." />
    </div>
  );
}
