import { Fragment, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/settings/Segmented";
import { XIcon } from "@/components/ui/icons";
import { cx } from "@/lib/cx";
import { useAnalytics } from "../context";
import {
  countByCountry,
  countryLabel,
  peopleCount,
  phraseStats,
  sentimentSplit,
  timeSeries,
  type PhraseStats,
} from "../engine/aggregate";
import { excerpt, matchesPhrase, topTerms } from "../engine/text";
import { SENTIMENTS, UNKNOWN_KEY, type AnalyticsRow } from "../engine/types";
import { BarList } from "../charts/BarList";
import { ChartCard, EmptyChart } from "../charts/ChartCard";
import { Donut } from "../charts/Donut";
import { LineChart } from "../charts/LineChart";
import { formatNumber, formatPercent } from "../charts/format";
import { SENTIMENT_COLOR, SENTIMENT_LABEL, seriesColor } from "../charts/palette";
import { Explain, TabGrid, Toolbar } from "./shared";

const MAX_PHRASES = 12;
const QUOTES = 8;

/**
 * How many people say a thing. Phrases are counted by rules (whole words, `*` for word endings,
 * `|` for alternatives), never paraphrased: every quote shown is the record's own text.
 */
export function VoiceTab() {
  const { dataset, rows, phrases, setPhrases } = useAnalytics();
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [ngram, setNgram] = useState<1 | 2>(1);

  const stats = useMemo(
    () =>
      phrases
        .map((p) => ({ phrase: p, stats: phraseStats(rows, p) }))
        .filter((s): s is { phrase: string; stats: PhraseStats } => s.stats !== null),
    [rows, phrases],
  );
  const terms = useMemo(
    () =>
      topTerms(
        rows.map((r) => r.text),
        { ngram, limit: 25 },
      ),
    [rows, ngram],
  );
  const active = stats.find((s) => s.phrase === selected) ?? stats[0] ?? null;
  const hasId = !!dataset.idColumn;

  if (!dataset.textual) {
    return (
      <TabGrid testId="analytics-voice">
        <div className="xl:col-span-2">
          <EmptyChart>
            These inputs are tables of figures, not people's words, so there is nothing to search.
            Connect customer feedback, a customer study or research results.
          </EmptyChart>
        </div>
      </TabGrid>
    );
  }

  const add = (raw: string) => {
    const phrase = raw.trim();
    if (!phrase || phrases.includes(phrase) || phrases.length >= MAX_PHRASES) return;
    setPhrases([...phrases, phrase]);
    setSelected(phrase);
    setDraft("");
  };

  return (
    <TabGrid testId="analytics-voice">
      <Toolbar className="rounded-xl border border-line bg-panel p-4">
        <form
          className="flex flex-1 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add(draft);
          }}
        >
          <label htmlFor="voice-phrase" className="text-sm font-medium text-ink">
            How many people say…
          </label>
          <input
            id="voice-phrase"
            data-testid="voice-phrase-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='seat | "lumbar support" | charg*'
            className="h-9 min-w-64 flex-1 rounded-lg border border-line bg-panel-2 px-3 text-sm text-ink placeholder:text-muted/70 focus:border-brand focus:ring-2 focus:ring-brand/20 focus:outline-none"
          />
          <Button
            type="submit"
            variant="primary"
            data-testid="voice-phrase-add"
            disabled={!draft.trim() || phrases.length >= MAX_PHRASES}
          >
            Track
          </Button>
        </form>
        <Explain>
          Whole words, case and accents ignored. <code>*</code> matches word endings, <code>|</code>{" "}
          or <code>OR</code> joins alternatives, quotes keep words together. Tracked phrases are
          saved with the block.
        </Explain>
      </Toolbar>

      <ChartCard
        title="Who says it"
        subtitle={
          hasId
            ? `Share of people (distinct "${dataset.idColumn}") who say each phrase at least once · click to inspect`
            : "Share of records that say each phrase (no ID column, so one record = one person) · click to inspect"
        }
        className="xl:col-span-2"
        testId="chart-voice-phrases"
        table={{
          columns: ["Phrase", "Records", "% of records", "People", "% of people"],
          rows: stats.map(({ phrase, stats: s }) => [
            phrase,
            formatNumber(s.count),
            formatPercent(s.share),
            formatNumber(s.people),
            formatPercent(s.peopleShare),
          ]),
        }}
      >
        {stats.length ? (
          <div className="flex flex-col gap-3">
            <BarList
              items={stats.map(({ phrase, stats: s }, i) => ({
                key: phrase,
                label: phrase,
                value: s.people,
                share: s.peopleShare,
                color: seriesColor(i),
                detail: `${formatNumber(s.count)} records (${formatPercent(s.share)})`,
              }))}
              max={peopleCount(rows)}
              showOther={false}
              selectedKeys={active ? [active.phrase] : []}
              ariaLabel="Share of people who say each phrase"
              onSelect={setSelected}
            />
            <div className="flex flex-wrap gap-1.5">
              {phrases.map((p) => (
                <span
                  key={p}
                  className="flex items-center gap-1 rounded-full border border-line bg-panel-2 py-0.5 pr-1 pl-2.5 text-xs text-ink"
                >
                  {p}
                  <button
                    type="button"
                    aria-label={`Stop tracking ${p}`}
                    className="rounded-full p-0.5 text-muted hover:bg-line hover:text-ink"
                    onClick={() => setPhrases(phrases.filter((x) => x !== p))}
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <EmptyChart>
            Track a phrase above, or click one of the most used words below, to see how many people
            say it — by country, over time and with their own words.
          </EmptyChart>
        )}
      </ChartCard>

      {active && <PhraseDetail phrase={active.phrase} stats={active.stats} />}

      <ChartCard
        title="Most used words"
        subtitle="By the share of records that use them at least once (stop words left out) · click to track"
        className="xl:col-span-2"
        actions={
          <Segmented<"1" | "2">
            options={[
              { value: "1", label: "Words" },
              { value: "2", label: "Two-word phrases" },
            ]}
            value={String(ngram) as "1" | "2"}
            onChange={(v) => setNgram(v === "2" ? 2 : 1)}
            testIdPrefix="voice-ngram-"
          />
        }
        testId="chart-voice-terms"
        table={{
          columns: ["Term", "Records", "Share"],
          rows: terms.map((t) => [t.term, formatNumber(t.docs), formatPercent(t.share)]),
        }}
      >
        {terms.length ? (
          <BarList
            items={terms.map((t) => ({
              key: t.term,
              label: t.term,
              value: t.docs,
              share: t.share,
              color: seriesColor(2),
            }))}
            limit={25}
            showOther={false}
            ariaLabel="Most used words"
            onSelect={(term) => add(ngram === 2 ? `"${term}"` : term)}
          />
        ) : (
          <EmptyChart>No word occurs in two or more records.</EmptyChart>
        )}
      </ChartCard>
    </TabGrid>
  );
}

function PhraseDetail({ phrase, stats }: { phrase: string; stats: PhraseStats }) {
  const { dataset, rows, granularity, countryColor, inputColor, inputs } = useAnalytics();
  const byCountry = useMemo(() => {
    const all = countByCountry(rows).filter((c) => c.key !== UNKNOWN_KEY);
    return all.slice(0, 12).map((c) => {
      const inCountry = rows.filter((r) => r.country === c.key);
      const hits = inCountry.filter((r) => matchesPhrase(r.text, stats.query)).length;
      return { key: c.key, label: c.label, total: inCountry.length, hits };
    });
  }, [rows, stats.query]);
  const byInput = useMemo(
    () =>
      dataset.inputs.map((i) => {
        const ofInput = rows.filter((r) => r.input === i.index);
        const hits = ofInput.filter((r) => matchesPhrase(r.text, stats.query)).length;
        return { ...i, total: ofInput.length, hits };
      }),
    [rows, dataset.inputs, stats.query],
  );
  const over = useMemo(
    () =>
      timeSeries(
        rows,
        granularity,
        [
          {
            key: phrase,
            label: phrase,
            colorIndex: 0,
            includes: () => true,
            counts: (r) => matchesPhrase(r.text, stats.query),
          },
        ],
        "share",
      ),
    [rows, granularity, phrase, stats.query],
  );
  const split = sentimentSplit(stats.matches);
  const inputLabel = (i: number) => inputs.find((x) => x.index === i)?.label ?? `Input ${i + 1}`;

  return (
    <>
      <ChartCard
        title={`"${phrase}" by country`}
        subtitle="Share of each country's records that say it"
        testId="chart-voice-country"
        table={{
          columns: ["Country", "Say it", "Records", "Share"],
          rows: byCountry.map((c) => [
            c.label,
            formatNumber(c.hits),
            formatNumber(c.total),
            formatPercent(c.total ? c.hits / c.total : 0),
          ]),
        }}
      >
        {byCountry.length ? (
          <BarList
            items={byCountry.map((c) => ({
              key: c.key,
              label: c.label,
              value: c.total ? c.hits / c.total : 0,
              color: countryColor(c.key),
              detail: `${formatNumber(c.hits)} of ${formatNumber(c.total)} records`,
            }))}
            max={1}
            valueFormat={formatPercent}
            showOther={false}
            ariaLabel={`Share saying ${phrase} by country`}
          />
        ) : (
          <EmptyChart>No country column, so this can't be split by country.</EmptyChart>
        )}
      </ChartCard>

      <ChartCard
        title={`Sentiment of the ${formatNumber(stats.count)} records that say it`}
        subtitle="Are people praising or complaining when they say it?"
        testId="chart-voice-sentiment"
        table={{
          columns: ["Sentiment", "Records", "Share"],
          rows: SENTIMENTS.map((s) => [
            SENTIMENT_LABEL[s],
            formatNumber(split[s]),
            formatPercent(stats.count ? split[s] / stats.count : 0),
          ]),
        }}
      >
        <Donut
          slices={SENTIMENTS.map((s) => ({
            key: s,
            label: SENTIMENT_LABEL[s],
            value: split[s],
            color: SENTIMENT_COLOR[s],
          }))}
          centerValue={formatPercent(stats.share)}
          centerLabel="of records"
          ariaLabel={`Sentiment of records saying ${phrase}`}
        />
      </ChartCard>

      {over[0] && (
        <ChartCard
          title={`"${phrase}" over time`}
          subtitle={`Share of records per ${granularity} that say it`}
          testId="chart-voice-time"
          table={{
            columns: ["Period", "Share"],
            rows: over[0].points.map((p) => [p.label, formatPercent(p.value)]),
          }}
        >
          <LineChart
            series={over}
            area
            valueFormat={formatPercent}
            axisFormat={formatPercent}
            height={200}
            ariaLabel={`${phrase} over time`}
          />
        </ChartCard>
      )}

      {byInput.length > 1 && (
        <ChartCard
          title={`"${phrase}" per input`}
          subtitle="Share of each input's records that say it"
          testId="chart-voice-inputs"
          table={{
            columns: ["Input", "Say it", "Records", "Share"],
            rows: byInput.map((i) => [
              i.label,
              formatNumber(i.hits),
              formatNumber(i.total),
              formatPercent(i.total ? i.hits / i.total : 0),
            ]),
          }}
        >
          <BarList
            items={byInput.map((i) => ({
              key: String(i.index),
              label: i.label,
              value: i.total ? i.hits / i.total : 0,
              color: inputColor(i.index),
              detail: `${formatNumber(i.hits)} of ${formatNumber(i.total)} records`,
            }))}
            max={1}
            valueFormat={formatPercent}
            showOther={false}
            ariaLabel={`Share saying ${phrase} per input`}
          />
        </ChartCard>
      )}

      <ChartCard
        title="In their own words"
        subtitle={`${Math.min(QUOTES, stats.matches.length)} of ${formatNumber(stats.count)} records, verbatim (shortened around the match)`}
        className="xl:col-span-2"
        testId="chart-voice-quotes"
      >
        <ul className="divide-y divide-line">
          {stats.matches.slice(0, QUOTES).map((row) => (
            <Quote key={row.id} row={row} query={stats.query} inputLabel={inputLabel(row.input)} />
          ))}
        </ul>
      </ChartCard>
    </>
  );
}

function Quote({
  row,
  query,
  inputLabel,
}: {
  row: AnalyticsRow;
  query: PhraseStats["query"];
  inputLabel: string;
}) {
  const { text, ranges } = excerpt(row.text, query, 120);
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return (
    <li className="py-2.5 text-sm">
      <blockquote className="text-ink">
        “
        {parts.map((p, i) => (
          <Fragment key={i}>
            {p.hit ? (
              <mark className="rounded-sm bg-brand-soft px-0.5 font-medium text-ink">{p.text}</mark>
            ) : (
              p.text
            )}
          </Fragment>
        ))}
        ”
      </blockquote>
      <div className={cx("mt-1 flex flex-wrap gap-x-3 text-xs text-muted")}>
        <span>{row.country ? countryLabel(row.country) : "No country"}</span>
        <span>{SENTIMENT_LABEL[row.sentiment]}</span>
        <span>{inputLabel}</span>
        <span>
          {row.sourceTitle}
          {row.locator ? `, ${row.locator}` : ""}
        </span>
      </div>
    </li>
  );
}
