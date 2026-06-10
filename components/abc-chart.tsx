"use client";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import { TrendingUp } from "lucide-react";
import { fmtN, fmtMoney } from "@/lib/utils";
import { useIsDark } from "@/lib/hooks";

// Pareto chart for the ABC report, split into its own module + loaded via
// next/dynamic (ssr:false) so recharts (~50kB) stays off the report route's
// initial bundle. Colours follow the reskin (violet cumulative line, semantic
// emerald/amber/slate bars) and the tooltip is theme-aware.

type ChartDatum = { idx: number; label: string; cls: string; revenue: number; cumPct: number };

export default function AbcChart({ chartData, totalRows }: { chartData: ChartDatum[]; totalRows: number }) {
  const isDark = useIsDark();
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp className="w-4 h-4 text-cyan-500" />
        <div className="text-sm font-medium">Pareto — revenue + cumulative %</div>
        <div className="text-xs text-zinc-500">
          top {chartData.length} {chartData.length === 40 && "of " + fmtN(totalRows)}
        </div>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-zinc-200 dark:stroke-zinc-800" />
            <XAxis dataKey="idx" tick={{ fontSize: 10, fill: "currentColor" }} className="text-zinc-500" axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="left" tick={{ fontSize: 10, fill: "currentColor" }} className="text-zinc-500" axisLine={false} tickLine={false}
              tickFormatter={(v) => v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
            />
            <YAxis
              yAxisId="right" orientation="right" domain={[0, 100]} tick={{ fontSize: 10, fill: "currentColor" }}
              className="text-zinc-500" axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              contentStyle={{
                background: isDark ? "#141822" : "#ffffff",
                border: `1px solid ${isDark ? "#1d2230" : "#dde1e9"}`,
                borderRadius: 10,
                fontSize: 12,
              }}
              labelStyle={{ color: isDark ? "#939bad" : "#69728a" }}
              formatter={(value: any, name: string) => {
                if (name === "revenue") return [fmtMoney(value), "Revenue"];
                if (name === "cumPct") return [`${value}%`, "Cumulative"];
                return [value, name];
              }}
              labelFormatter={(idx: number) => {
                const d = chartData[idx - 1];
                return d ? `#${idx} · ${d.label} · ${d.cls}` : `#${idx}`;
              }}
            />
            <Bar yAxisId="left" dataKey="revenue" radius={[2, 2, 0, 0]}>
              {chartData.map((d, i) => (
                <Cell key={i} fill={d.cls === "A" ? "#10b981" : d.cls === "B" ? "#f59e0b" : "#69728a"} />
              ))}
            </Bar>
            <Line yAxisId="right" type="monotone" dataKey="cumPct" stroke="#7c3aed" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
