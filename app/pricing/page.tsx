"use client";
import { Shell } from "@/components/shell";
import { Construction } from "lucide-react";

export default function Page() {
  return (
    <Shell title="Pricing">
      <Placeholder text="Per-item pricing — LP, discount, taxable rate, +18% GST. Coming next session." />
    </Shell>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center">
      <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl flex items-center justify-center mb-4">
        <Construction className="w-7 h-7 text-zinc-500" />
      </div>
      <h2 className="text-lg font-semibold">Coming next session</h2>
      <p className="text-sm text-zinc-500 mt-2 max-w-md">{text}</p>
    </div>
  );
}
