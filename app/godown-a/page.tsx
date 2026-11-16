"use client";
// Godown A = the Items screen showing only Godown A's stock (cases, loose, pieces).
import { ItemsView } from "@/components/items-view";

export default function Page() {
  return <ItemsView godown="A" />;
}
