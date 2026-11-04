// Map color scales. Every map sits on the dark sea plate, so low values are dim and high values bright.
// One hue per measure: blue for income, orange for poverty. Blue and red only for change.
// Income is in pesos per month.
import { fmt } from "./lib.js";

export const SEA = "#0a1c24";
export const NODATA = "#22323a";
export const LAND = "#21404c";

export const RAMPS = {
  income: {
    key: "i", label: "Average monthly household income", short: "Income", unit: "₱ per month",
    breaks: [20000, 25000, 30000, 35000, 40000, 50000],
    colors: ["#20385c", "#2b5087", "#376ab5", "#4685e2", "#64a3ff", "#91c2ff", "#c2e0ff"],
    labels: ["Under ₱20,000", "₱20,000 to ₱25,000", "₱25,000 to ₱30,000", "₱30,000 to ₱35,000", "₱35,000 to ₱40,000", "₱40,000 to ₱50,000", "₱50,000 or more"],
    ends: ["Under ₱20k", "₱50k or more"],
    tick: (b) => fmt.pesoAxis(b),
    format: (v) => (v == null ? "n/a" : fmt.peso(v)),
  },
  poverty: {
    key: "p", label: "Poverty incidence", short: "Poverty", unit: "% of people",
    breaks: [2, 5, 10, 15, 20, 30],
    colors: ["#533526", "#7c452b", "#a55533", "#d2653a", "#fb794d", "#ffa175", "#ffc9ae"],
    labels: ["Under 2%", "2 to 5%", "5 to 10%", "10 to 15%", "15 to 20%", "20 to 30%", "30% or more"],
    ends: ["Under 2%", "30% or more"],
    tick: (b) => `${b}%`,
    format: (v) => (v == null ? "n/a" : `${v.toFixed(1)}%`),
  },
};

// change between two versions: blue means the newer figure is lower, red means higher
const DIV = ["#4c88d3", "#436590", "#2f4a63", "#3a4347", "#6b3f3c", "#904d49", "#d15c56"];
export const DIFF = {
  income: {
    breaks: [-25, -10, -2, 2, 10, 25], colors: DIV, label: "Change in income", unit: "percent",
    labels: ["Down 25% or more", "Down 10 to 25%", "Down 2 to 10%", "Within 2%", "Up 2 to 10%", "Up 10 to 25%", "Up 25% or more"],
    format: (v) => `${fmt.pts(v, 1)}%`,
  },
  poverty: {
    breaks: [-10, -5, -1, 1, 5, 10], colors: DIV, label: "Change in poverty", unit: "percentage points",
    labels: ["Down 10 or more", "Down 5 to 10", "Down 1 to 5", "Within 1 point", "Up 1 to 5", "Up 5 to 10", "Up 10 or more"],
    format: (v) => `${fmt.pts(v, 1)} points`,
  },
};

export function colorOf(ramp, v) {
  if (v == null) return NODATA;
  let i = 0;
  while (i < ramp.breaks.length && v >= ramp.breaks[i]) i += 1;
  return ramp.colors[i];
}
