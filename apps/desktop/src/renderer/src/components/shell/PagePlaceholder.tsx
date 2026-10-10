/** Temporary page body until the owning workstream builds the real screen. Delete usages when done. */
export function PagePlaceholder(props: {
  title: string;
  purpose: string;
  owner: string;
  builds: string[];
}) {
  return (
    <div className="mx-auto max-w-3xl p-10">
      <h1 className="text-2xl font-semibold">{props.title}</h1>
      <p className="mt-2 text-muted">{props.purpose}</p>
      <div className="mt-6 rounded-lg border border-dashed border-line bg-panel p-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          Not built yet — owner {props.owner} (docs/WORKSTREAMS.md)
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
          {props.builds.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
