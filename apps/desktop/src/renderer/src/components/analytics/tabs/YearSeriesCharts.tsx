import { useMemo } from "react";
import { useAnalytics } from "../context";
import { colorSlots, countByCountry, countryLabel } from "../engine/aggregate";
import { ChartCard } from "../charts/ChartCard";
import { LineChart } from "../charts/LineChart";
import { formatNumber } from "../charts/format";
import { groupYearSeries } from "./year-series";

/** Figures per year from year columns (e.g. sales volumes with plan years), one chart per measure. */
export function YearSeriesCharts() {
  const { dataset, allRows, filters } = useAnalytics();
  const groups = useMemo(() => {
    const slots = colorSlots(countByCountry(allRows));
    const points = dataset.yearSeries.filter(
      (p) =>
        (!filters.inputs?.length || filters.inputs.includes(p.input)) &&
        (!filters.countries?.length ||
          (p.country !== null && filters.countries.includes(p.country))),
    );
    return groupYearSeries(points, {
      labelOf: (p) => (p.country ? countryLabel(p.country) : p.label),
      colorIndexOf: (p, order) => (p.country ? (slots.get(p.country) ?? 8) : order),
      inputs: dataset.inputs.length,
      inputLabel: (i) => dataset.inputs.find((x) => x.index === i)?.label ?? `Input ${i + 1}`,
    });
  }, [dataset, allRows, filters.inputs, filters.countries]);

  return (
    <>
      {groups.map((group) => (
        <ChartCard
          key={group.name}
          title={`${group.name} per year`}
          subtitle={`From the year columns (${group.years.join(", ")}), one line per row`}
          className="xl:col-span-2"
          testId="chart-year-series"
          table={{
            columns: ["Row", ...group.years.map(String)],
            rows: group.series.map((s) => [s.label, ...s.points.map((p) => formatNumber(p.value))]),
          }}
          footnote={[
            group.dashedFrom !== undefined ? "Dashed: plan years after this one, not actuals." : "",
            group.irregular
              ? "Only the years that are columns are shown, so gaps between them are one step."
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <LineChart
            series={group.series}
            dashedFrom={group.dashedFrom}
            ariaLabel={`${group.name} per year`}
          />
        </ChartCard>
      ))}
    </>
  );
}
