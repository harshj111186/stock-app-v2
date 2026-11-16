"use client";
// Godown B = the Items screen showing only Godown B's stock (cases, loose, pieces).
import { ItemsView } from "@/components/items-view";

export default function Page() {
  return <ItemsView godown="B" />;
}
