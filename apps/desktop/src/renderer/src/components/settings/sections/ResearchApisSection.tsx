import {
  APIFY_ACTORS,
  type ConnectionReport,
  type ResearchProviderStatus,
  type SecretName,
} from "@reqflow/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../ui/Button";
import { Select, TextInput, Toggle } from "../../ui/controls";
import { api } from "../../../lib/api";
import { settingsStore } from "../../../lib/settings";
import { SettingRow } from "../SettingRow";
import {
  CONNECTION_LABELS,
  RESEARCH_PROVIDER_CARDS,
  createResearchSettingsController,
  nonEmptySecretDraft,
  validateRedditUserAgent,
  type ProviderCardDefinition,
  type ResearchSettingsController,
} from "./ResearchApisSection.helpers";

/** Shared with the Anthropic input. Configured credentials are never input values. */
export function CredentialInput(props: {
  id: string;
  label: string;
  optional?: boolean;
  configured: boolean | undefined;
  source?: "keychain" | "env" | null;
  draft: string;
  disabled: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={props.id} className="text-sm font-medium text-ink">
          {props.label}
          {props.optional ? " (optional)" : ""}
        </label>
        <span className={props.configured ? "text-xs text-ink" : "text-xs text-muted"}>
          {props.configured === undefined
            ? "Status unavailable"
            : props.configured
              ? "Configured · not a connection test"
              : "Not set"}
          {props.configured && props.source
            ? ` (${props.source === "env" ? "environment" : "OS keychain"})`
            : ""}
        </span>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.disabled && nonEmptySecretDraft(props.draft) !== null) props.onSave();
        }}
      >
        <TextInput
          id={props.id}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="none"
          value={props.draft}
          onChange={props.onDraft}
          disabled={props.disabled}
          placeholder="Enter a new credential"
          aria-describedby={`${props.id}-help`}
          className="min-w-36 flex-1"
        />
        <Button
          type="submit"
          size="sm"
          aria-label={`Save ${props.label}`}
          disabled={props.disabled || nonEmptySecretDraft(props.draft) === null}
        >
          Save
        </Button>
        {props.configured === true && (
          <Button
            variant="danger"
            size="sm"
            disabled={props.disabled}
            onClick={props.onRemove}
            aria-label={`Remove saved ${props.label}`}
          >
            Remove
          </Button>
        )}
      </form>
      <p id={`${props.id}-help`} className="text-xs text-muted">
        Stored credentials stay hidden. A blank Save does nothing; only Remove deletes a saved
        credential. Drafts are cleared when submitted, on errors, and when you leave this section.
      </p>
    </div>
  );
}

export function ConnectionDetails({ report }: { report: ConnectionReport }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm" role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={report.state === "success" ? "font-medium text-ok" : "font-medium text-ink"}
        >
          {CONNECTION_LABELS[report.state]}
        </span>
        <code className="break-all text-xs text-muted">{report.state}</code>
      </div>
      <p className="mt-1 break-words text-muted">{report.message}</p>
      {report.testedAt && (
        <p className="mt-1 text-xs text-muted">
          Last test: <time dateTime={report.testedAt}>{report.testedAt}</time>
        </p>
      )}
      {report.capabilities.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-ink">Reported capabilities</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted">
            {report.capabilities.map((item, index) => (
              <li key={index} className="break-words">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.limitations.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-ink">Limitations</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted">
            {report.limitations.map((item, index) => (
              <li key={index} className="break-words">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RedditUserAgent(props: {
  value: string;
  disabled: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);
  const error = validateRedditUserAgent(draft);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="reddit-user-agent" className="text-sm font-medium text-ink">
        Reddit user-agent
      </label>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.disabled && !error && draft.trim() !== props.value) props.onSave(draft.trim());
        }}
      >
        <TextInput
          id="reddit-user-agent"
          value={draft}
          onChange={setDraft}
          disabled={props.disabled}
          maxLength={200}
          placeholder="desktop:ReqFlow:0.1 (by /u/your_username)"
          aria-invalid={!!error}
          aria-describedby="reddit-user-agent-help"
          className="min-w-36 flex-1"
        />
        <Button
          size="sm"
          type="submit"
          disabled={props.disabled || !!error || draft.trim() === props.value}
        >
          Save user-agent
        </Button>
      </form>
      <p id="reddit-user-agent-help" className="text-xs text-muted">
        {error ??
          "Identify your approved app, version, and Reddit contact. No credential belongs here."}
      </p>
    </div>
  );
}

function ProviderCard(props: {
  definition: ProviderCardDefinition;
  status: ResearchProviderStatus | undefined;
  controller: ResearchSettingsController;
  drafts: Partial<Record<SecretName, string>>;
  busy: boolean;
  loading: boolean;
}) {
  const { definition, status, controller, busy } = props;
  return (
    <article
      data-testid={`research-provider-${definition.id}`}
      aria-labelledby={`provider-${definition.id}-title`}
      className="rounded-xl border border-line bg-panel p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={`provider-${definition.id}-title`} className="font-semibold text-ink">
            {definition.label}
          </h4>
          <p className="mt-1 text-sm text-muted">{definition.description}</p>
        </div>
        {definition.docs && (
          <a
            href={definition.docs}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`${definition.label} official API documentation`}
            className="shrink-0 rounded text-xs text-brand underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Official docs
          </a>
        )}
      </div>
      {!status ? (
        <p className="mt-3 text-sm text-muted">
          {props.loading
            ? "Loading provider status…"
            : "Provider status unavailable. Reload to retry; no access state is assumed."}
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          <SettingRow
            label="Enabled for research"
            description="Permits use in an explicit workflow run. Does not start research or grant platform approval."
          >
            <div className="flex items-center gap-2">
              <Toggle
                value={status.config.enabled}
                onChange={(enabled) => {
                  void controller.configure(definition.id, { enabled });
                }}
                disabled={busy}
                label={`Enable ${definition.label} for research`}
              />
              <span className="text-sm text-muted">
                {status.config.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
          </SettingRow>
          {definition.credentials.map((credential) => (
            <CredentialInput
              key={credential.name}
              id={credential.name}
              label={credential.label}
              optional={credential.optional}
              configured={status.credentialsConfigured[credential.name]}
              draft={props.drafts[credential.name] ?? ""}
              disabled={busy}
              onDraft={(draft) => controller.setDraft(credential.name, draft)}
              onSave={() => {
                void controller.saveSecret(credential.name);
              }}
              onRemove={() => {
                void controller.removeSecret(credential.name);
              }}
            />
          ))}
          {definition.credentials.length === 0 && (
            <p className="text-xs text-muted">No API key required.</p>
          )}
          {(definition.id === "apify" || definition.id === "reddit") && (
            <SettingRow
              label="Platform / research approval"
              description="Only record Granted if you have the required rights and provider approval. A connection test does not grant these rights."
            >
              <div className="flex items-center gap-2">
                <Toggle
                  value={status.config.approval === "granted"}
                  onChange={(granted) => {
                    void controller.configure(definition.id, {
                      approval: granted ? "granted" : "not_granted",
                    });
                  }}
                  disabled={busy}
                  label={`Confirm required ${definition.label} platform approval`}
                />
                <span className="text-sm text-muted">
                  {status.config.approval === "granted" ? "Granted" : "Not granted"}
                </span>
              </div>
            </SettingRow>
          )}
          {definition.id === "apify" && (
            <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
              <legend className="mb-2 text-sm font-medium text-ink">
                Allowed actors · fixed allowlist
              </legend>
              <p className="text-xs text-muted">
                No actor runs here. Allow only actors you intend to use and are authorized to run.
              </p>
              {APIFY_ACTORS.map((actor) => (
                <label key={actor} className="flex items-start gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="mt-1 accent-brand focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
                    checked={status.config.allowedActors.includes(actor)}
                    onChange={(event) => {
                      const allowedActors = event.target.checked
                        ? [...status.config.allowedActors, actor]
                        : status.config.allowedActors.filter((value) => value !== actor);
                      void controller.configure("apify", { allowedActors });
                    }}
                  />
                  <code className="break-all text-xs leading-6">{actor}</code>
                </label>
              ))}
            </fieldset>
          )}
          {definition.id === "x" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="x-search-mode" className="text-sm font-medium text-ink">
                X search mode
              </label>
              <Select
                id="x-search-mode"
                value={status.config.xSearchMode}
                disabled={busy}
                options={[
                  { value: "recent", label: "Recent search" },
                  { value: "full_archive", label: "Full archive · requires plan access" },
                ]}
                onChange={(value) => {
                  if (value === "recent" || value === "full_archive")
                    void controller.configure("x", { xSearchMode: value });
                }}
              />
            </div>
          )}
          {definition.id === "reddit" && (
            <RedditUserAgent
              value={status.config.redditUserAgent}
              disabled={busy}
              onSave={(redditUserAgent) => {
                void controller.configure("reddit", { redditUserAgent });
              }}
            />
          )}
          <ConnectionDetails report={status.connection} />
          <div className="flex flex-wrap items-start gap-3">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void controller.test(definition.id);
              }}
              aria-describedby={`provider-${definition.id}-test-help`}
            >
              Test connection
            </Button>
            <p
              id={`provider-${definition.id}-test-help`}
              className="min-w-36 flex-1 text-xs text-muted"
            >
              {definition.id === "local_documents"
                ? "Checks local access only; no external request."
                : "Explicit, small connection check. May consume API quota or credits; no research run starts."}{" "}
              Does not enable this provider or grant platform approval.
            </p>
          </div>
        </div>
      )}
    </article>
  );
}

export function ResearchApisSection() {
  const [controller] = useState(() =>
    createResearchSettingsController(api, () => settingsStore.getState().reloadResearchApis()),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.activate();
    void controller.refresh();
    return () => controller.deactivate();
  }, [controller]);
  const busy = state.pending !== null;

  return (
    <div data-testid="research-apis-section" className="flex flex-col gap-6" aria-busy={busy}>
      <div>
        <h2 className="text-lg font-semibold text-ink">Research APIs &amp; Zugänge</h2>
        <p className="mt-1 text-sm text-muted">
          Manage research access separately from AI models. Stored credentials, provider enablement,
          platform approval, and connection tests are separate states.
        </p>
      </div>
      <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm text-muted">
        Credentials are sent only to the main process for secure storage. Saving a credential never
        activates a provider or starts research. Tests run only when you press Test connection and
        may consume quota or credits.
      </div>
      <div className="flex flex-col gap-2">
        <Button
          className="self-start"
          size="sm"
          disabled={busy}
          onClick={() => {
            void controller.refresh();
          }}
        >
          Reload provider status
        </Button>
        {state.pending && (
          <p role="status" className="text-sm text-muted">
            {state.pending}
          </p>
        )}
        {state.notice && (
          <p role="status" className="text-sm text-ink">
            {state.notice}
          </p>
        )}
        {state.error && (
          <p
            role="alert"
            className="rounded-lg border border-line bg-danger-soft p-3 text-sm text-danger"
          >
            {state.error}
          </p>
        )}
      </div>
      {(["Web search", "Social & community", "Studies & documents"] as const).map((group) => (
        <section
          key={group}
          aria-labelledby={`research-group-${group.split(" ")[0]}`}
          className="flex flex-col gap-3"
        >
          <h3
            id={`research-group-${group.split(" ")[0]}`}
            className="text-sm font-semibold text-ink"
          >
            {group}
          </h3>
          {RESEARCH_PROVIDER_CARDS.filter((definition) => definition.group === group).map(
            (definition) => (
              <ProviderCard
                key={definition.id}
                definition={definition}
                status={state.statuses?.find((status) => status.id === definition.id)}
                controller={controller}
                drafts={state.drafts}
                busy={busy}
                loading={state.statuses === null && !state.error}
              />
            ),
          )}
        </section>
      ))}
    </div>
  );
}
