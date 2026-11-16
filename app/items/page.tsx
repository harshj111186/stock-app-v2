"use client";
// Items — see components/items-view.tsx (2026-11-16 redesign: category tree,
// compact rows, item panel). The old page's count-correction modal now lives
// in components/edit-stock-modal.tsx, unchanged.
import { ItemsView } from "@/components/items-view";

export default function ItemsPage() {
  return <ItemsView />;
}
