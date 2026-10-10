import { useState, type FormEvent } from "react";
import { useSettings, settingsStore } from "@/lib/settings";
import { SettingRow } from "../SettingRow";
import { Segmented } from "../Segmented";
import { Select, TextInput, Toggle, ValidatedTextInput } from "@/components/ui/controls";
import { Button } from "@/components/ui/Button";
import { TrashIcon } from "../icons";
import { cx } from "@/lib/cx";
import { MemberRole } from "@reqflow/core";

/** "Anna Maria Schmidt" → "AS". */
function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : (words[0]?.[1] ?? "");
  return (first + last).toUpperCase();
}

const ROLE_OPTIONS = [
  { value: "owner", label: "Owner" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" },
] as const;

const SHARING_OPTIONS = [
  { value: "local", label: "This computer" },
  { value: "shared_folder", label: "Shared folder" },
  { value: "git", label: "Git repo" },
] as const;

export function CollaborationSection() {
  const review = useSettings((s) => s.settings.review);
  const col = useSettings((s) => s.settings.collaboration);

  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("editor");
  const [inviteError, setInviteError] = useState<string | null>(null);

  const handleInvite = (e: FormEvent) => {
    e.preventDefault();
    const newMember = {
      id: crypto.randomUUID(),
      name: inviteName.trim(),
      email: inviteEmail.trim(),
      role: inviteRole,
      status: "invited" as const,
    };
    const err = settingsStore
      .getState()
      .update("collaboration", { members: [...col.members, newMember] });

    if (err) {
      setInviteError(err);
    } else {
      setInviteError(null);
      setInviteName("");
      setInviteEmail("");
      setInviteRole("editor");
    }
  };

  const removeMember = (id: string) => {
    settingsStore
      .getState()
      .update("collaboration", { members: col.members.filter((m) => m.id !== id) });
  };

  const updateMemberRole = (id: string, value: string) => {
    const role = MemberRole.safeParse(value);
    if (!role.success) return;
    settingsStore.getState().update("collaboration", {
      members: col.members.map((m) => (m.id === id ? { ...m, role: role.data } : m)),
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-lg font-semibold text-ink">Collaboration</h2>
        <p className="mt-1 text-sm text-muted">
          Work on the same flows and decisions with your team.
        </p>
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 text-sm font-semibold text-ink">You</h3>
        <SettingRow
          label="Name"
          description="Your name appears in the audit trail next to every decision you make."
        >
          <ValidatedTextInput
            aria-label="Your name"
            value={review.reviewer.name}
            onCommit={(name) =>
              settingsStore
                .getState()
                .update("review", { reviewer: { ...review.reviewer, name: name.trim() } })
            }
          />
        </SettingRow>
        <SettingRow label="Role">
          <ValidatedTextInput
            aria-label="Your role"
            value={review.reviewer.role}
            onCommit={(role) =>
              settingsStore
                .getState()
                .update("review", { reviewer: { ...review.reviewer, role: role.trim() } })
            }
          />
        </SettingRow>
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 text-sm font-semibold text-ink">Team</h3>
        {col.members.length === 0 ? (
          <div className="mb-4 text-sm text-muted">No teammates yet.</div>
        ) : (
          <div className="mb-4 flex flex-col gap-3">
            {col.members.map((m) => {
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 p-3"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft font-medium text-brand">
                    {initials(m.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{m.name}</div>
                    <div className="truncate text-xs text-muted">{m.email}</div>
                  </div>
                  <div className="w-32">
                    <Select
                      options={ROLE_OPTIONS}
                      value={m.role}
                      onChange={(role) => updateMemberRole(m.id, role)}
                    />
                  </div>
                  <div
                    className={cx(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                      m.status === "invited" ? "bg-warn-soft text-warn" : "bg-ok/20 text-ok",
                    )}
                  >
                    {m.status}
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${m.name}`}
                    onClick={() => removeMember(m.id)}
                    className="p-1.5 text-muted hover:text-danger"
                  >
                    <TrashIcon className="size-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <form onSubmit={handleInvite} className="rounded-lg border border-line bg-panel-2 p-4">
          <h4 className="mb-3 text-sm font-medium text-ink">Invite teammate</h4>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <TextInput
              placeholder="Name"
              value={inviteName}
              onChange={setInviteName}
              required
              className="flex-1"
            />
            <TextInput
              placeholder="Email address"
              type="email"
              data-testid="invite-email"
              value={inviteEmail}
              onChange={setInviteEmail}
              required
              className="flex-1"
            />
            <div className="w-32">
              <Select
                options={ROLE_OPTIONS}
                value={inviteRole}
                onChange={(value) => {
                  const role = MemberRole.safeParse(value);
                  if (role.success) setInviteRole(role.data);
                }}
              />
            </div>
            <Button type="submit" variant="primary" data-testid="invite-submit">
              Invite
            </Button>
          </div>
          {inviteError && <div className="mt-2 text-xs text-danger">{inviteError}</div>}
          <div className="mt-3 text-xs text-muted">
            Invitations are kept on this computer for now — sending them needs the sync service,
            which isn't built yet.
          </div>
        </form>
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 text-sm font-semibold text-ink">Sharing</h3>
        <SettingRow label="Mode">
          <Segmented
            options={SHARING_OPTIONS}
            value={col.sharing}
            onChange={(sharing) => settingsStore.getState().update("collaboration", { sharing })}
          />
        </SettingRow>
        {col.sharing !== "local" && (
          <SettingRow label="Location">
            <div className="flex flex-col gap-1.5">
              <TextInput
                value={col.sharedLocation}
                onChange={(sharedLocation) =>
                  settingsStore.getState().update("collaboration", { sharedLocation })
                }
                placeholder={
                  col.sharing === "git"
                    ? "https://github.com/your-org/reqflow-data.git"
                    : "/Volumes/Team/ReqFlow"
                }
              />
              {!col.sharedLocation && (
                <p className="text-xs text-warn">Location is required for sharing.</p>
              )}
            </div>
          </SettingRow>
        )}
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 text-sm font-semibold text-ink">Notifications & approvals</h3>
        <SettingRow label="Notify teammates when a HIL block waits for them">
          <Toggle
            value={col.notifyOnReview}
            onChange={(notifyOnReview) =>
              settingsStore.getState().update("collaboration", { notifyOnReview })
            }
          />
        </SettingRow>
        <SettingRow label="Require a second approval for requirements">
          <Toggle
            value={col.requireSecondApproval}
            onChange={(requireSecondApproval) =>
              settingsStore.getState().update("collaboration", { requireSecondApproval })
            }
          />
        </SettingRow>
      </div>

      <div className="mt-2 flex gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => settingsStore.getState().resetSection("review")}
        >
          Reset you
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => settingsStore.getState().resetSection("collaboration")}
        >
          Reset collaboration
        </Button>
      </div>
    </div>
  );
}
