import { useState } from "react";
import type { SecretName, SecretStatus } from "@reqflow/core";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/controls";

export function SecretEditor({
  name,
  onSaved,
}: {
  name: SecretName;
  onSaved: (status: SecretStatus) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.settings.setSecret(name, value));
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the key");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-2">
        <TextInput
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={`New ${name}`}
          data-testid={`secret-${name}`}
          placeholder="Enter or replace key (never displayed)"
          value={draft}
          onChange={setDraft}
          disabled={busy}
        />
        <Button size="sm" disabled={busy || !draft.trim()} onClick={() => void save(draft.trim())}>
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
          Remove
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
