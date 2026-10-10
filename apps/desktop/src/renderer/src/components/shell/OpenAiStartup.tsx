import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/controls";
import { saveStartupOpenAiKey } from "./openai-startup";

/** Ask on every fresh app/window launch, never retrieve or prefill an existing secret. */
export function OpenAiStartup() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [checking, setChecking] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    api.settings.secrets().then(
      (status) => {
        if (active) {
          setConfigured(status.openai_api_key.configured);
          setChecking(false);
        }
      },
      () => {
        if (active) {
          setError("Couldn't check the saved key. You can enter one below or continue without AI.");
          setChecking(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const close = () => {
    setDraft("");
    setDismissed(true);
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveStartupOpenAiKey(api.settings.setSecret, draft);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the key.");
    } finally {
      setBusy(false);
    }
  };

  if (dismissed) return null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="openai-startup-title"
      aria-describedby="openai-startup-description"
      data-testid="openai-startup"
      className="m-auto w-[min(32rem,90vw)] rounded-xl border border-line bg-panel p-6 text-ink shadow-xl backdrop:bg-black/60"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 id="openai-startup-title" className="text-xl font-semibold">
          Connect OpenAI for Mastra
        </h2>
        <p id="openai-startup-description" className="mt-2 text-sm text-muted">
          Enter your OpenAI API key to use the live AI Judge agents. Your key is stored with
          OS-protected encryption, never displayed or added to a workflow.
        </p>
        <label htmlFor="openai-startup-key" className="mb-1 mt-4 block text-sm font-medium">
          OpenAI API key
        </label>
        <TextInput
          id="openai-startup-key"
          data-testid="openai-startup-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          placeholder="Enter your OpenAI API key"
          value={draft}
          onChange={setDraft}
          disabled={busy}
        />
        <p className="mt-2 text-xs text-muted">
          {checking
            ? "Checking key configuration…"
            : configured
              ? "A key is already configured. Use it or enter a replacement."
              : "No OpenAI key is configured yet."}
        </p>
        <p className="mt-2 text-xs text-muted">
          Live runs send selected evidence to OpenAI and may incur API charges. AI only proposes;
          you decide.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="primary"
            data-testid="openai-startup-save"
            disabled={busy || !draft.trim()}
          >
            {busy ? "Saving…" : "Save key & continue"}
          </Button>
          {configured && (
            <Button data-testid="openai-startup-existing" disabled={busy} onClick={close}>
              Use configured key
            </Button>
          )}
          <Button variant="ghost" data-testid="openai-startup-skip" disabled={busy} onClick={close}>
            Continue without entering a key
          </Button>
        </div>
      </form>
    </dialog>
  );
}
