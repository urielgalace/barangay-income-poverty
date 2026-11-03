// Methodology page: which inputs the models rely on, and how they compare with simpler approaches on held-out data.
import { getJSON, figure } from "./lib.js?b=50f9fd3b4a";
import { barsH } from "./charts.js?b=50f9fd3b4a";

const two = (v) => v.toFixed(2);
const three = (v) => (v == null ? "n/a" : v.toFixed(3));

function chart(id, { title, sub, rows, color, table }) {
  figure(document.getElementById(id), {
    title,
    sub,
    // rearranging a group can raise a score by chance, so a bar never runs below zero; the table keeps the true value
    draw: (b, w) => barsH(b, w, { rows: rows.map((r) => ({ ...r, value: Math.max(r.value, 0), color: r.used === false ? "context" : color })), color, format: two, labelWidth: Math.min(w * 0.6, 178) }),
    table,
  });
}

async function boot() {
  const M = await getJSON("methodology.json");
  chart("importance-income", {
    title: "Feature importance in the household income model",
    sub: "Reduction in R² on held-out areas when each group of inputs is randomly rearranged.",
    rows: M.importance.income,
    color: "income",
    table: () => ({ headers: ["Inputs", "Number of inputs", "R² when rearranged", "Reduction in R²"], numeric: [0, 1, 1, 1], rows: M.importance.income.map((r) => [r.label, r.inputs, three(r.score), three(r.value)]) }),
  });
  chart("importance-poverty", {
    title: "Feature importance in the poverty model",
    sub: "Reduction in rank correlation on held-out surveys when each group of inputs is randomly rearranged.",
    rows: M.importance.poverty,
    color: "poverty",
    table: () => ({ headers: ["Inputs", "Number of inputs", "Rank correlation when rearranged", "Reduction"], numeric: [0, 1, 1, 1], rows: M.importance.poverty.map((r) => [r.label, r.inputs, three(r.score), three(r.value)]) }),
  });
  chart("models-income", {
    title: "Comparison of income models",
    sub: "Share of differences explained (R²) on held-out provinces and cities. Higher is better.",
    rows: M.income_models.map((r) => ({ ...r, used: !!r.used })),
    color: "income",
    table: () => ({ headers: ["Model", "R²", "Average error %"], numeric: [0, 1, 1], rows: M.income_models.map((r) => [r.label, three(r.value), r.error]) }),
  });
  chart("models-poverty", {
    title: "Comparison of poverty models",
    sub: "Rank correlation with surveyed poverty within a municipality, on held-out reports. Higher is better.",
    rows: M.poverty_models.map((r) => ({ ...r, used: !!r.used })),
    color: "poverty",
    table: () => ({ headers: ["Model", "Rank correlation", "Rank correlation, five cities", "R² within a municipality"], numeric: [0, 1, 1, 1], rows: M.poverty_models.map((r) => [r.label, three(r.value), three(r.cities), three(r.r2)]) }),
  });
}
boot().catch(console.error);
