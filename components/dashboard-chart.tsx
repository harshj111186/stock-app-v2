"use client";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";

// Sales-trend sparkline-ish area chart for the dashboard. Loaded via
// next/dynamic (ssr:false) so recharts (~50kB) stays out of the initial
// payload and only lands when the dashboard actually mounts.
//
// `data` = one point per day: { label: "12 May", units: number }.

export default function DashboardChart({ data }: { data: { label: string; units: number }[] }) {
  const isDark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const grid = isDark ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.06)";
  const axis = isDark ? "#69728a" : "#939bad";

  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={grid} vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: axis }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis
          tick={{ fontSize: 10, fill: axis }}
          tickLine={false}
          axisLine={false}
          width={32}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ stroke: "#7c3aed", strokeWidth: 1, strokeDasharray: "3 3" }}
          contentStyle={{
            background: isDark ? "#141822" : "#ffffff",
            border: `1px solid ${isDark ? "#1d2230" : "#dde1e9"}`,
            borderRadius: 10,
            fontSize: 12,
            padding: "6px 10px",
          }}
          labelStyle={{ color: axis, marginBottom: 2 }}
          formatter={(v: number) => [`${v} units`, "Sold"]}
        />
        <Area
          type="monotone"
          dataKey="units"
          stroke="#7c3aed"
          strokeWidth={2}
          fill="url(#salesFill)"
          dot={false}
          activeDot={{ r: 3, fill: "#7c3aed" }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
