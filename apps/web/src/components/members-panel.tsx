/**
 * The organization member panel.
 *
 * Extracted so the Members page and the organization Settings page render one
 * implementation of the same list: the same rank rules, the same honesty about
 * a member the platform has no profile for, and the same two dialogs. Two
 * copies would drift the moment one grew a control the other did not.
 *
 * The rank rules here mirror the server's, as a courtesy that keeps a control
 * from being offered where it would be refused. They are not the guard: the
 * procedure and the database policy both re-check, and a refusal is surfaced.
 */
import { useState } from "react";
import {
  Button,
  Card,
  Modal,
  SectionShell,
  SectionView,
  StatusBadge,
  Table,
  TextInput,
} from "@cloud-wai/ui/react";
import { useApp } from "../react/context.js";
import { useSection } from "../react/hooks.js";
import {
  loadOrganizationMembers,
  removeMember,
  updateMemberRole,
  type OrganizationMemberSummary,
} from "../view-model.js";
import { Timestamp } from "./page-parts.js";

export interface MembersPanelProps {
  readonly organizationId: string;
  /**
   * Whether the caller may change roles and remove members.
   *
   * Left undefined, the panel decides from the caller's own membership row,
   * which is the only way it can be right on the standalone Members page. The
   * Settings page passes its already-computed answer so the two surfaces agree
   * even while the list is still loading.
   */
  readonly canManage?: boolean | undefined;
}

export function MembersPanel({ organizationId, canManage }: MembersPanelProps) {
  const { client, session } = useApp();
  const members = useSection(
    () => loadOrganizationMembers(client, organizationId),
    [client, organizationId],
    "Members",
  );

  const [editing, setEditing] = useState<OrganizationMemberSummary | null>(null);
  const [removing, setRemoving] = useState<OrganizationMemberSummary | null>(null);

  const currentUserId = session.current()?.userId ?? null;
  const memberRows = members.section.state.kind === "ready" ? members.section.state.items : [];
  const myRole = memberRows.find((m) => m.userId === currentUserId)?.role ?? null;
  const isOwner = myRole === "owner";
  const canInvite = canManage ?? (isOwner || myRole === "admin");

  const canChangeRole = (item: OrganizationMemberSummary) =>
    canInvite && item.userId !== currentUserId && (isOwner || item.role !== "owner");
  const canRemove = (item: OrganizationMemberSummary) => {
    if (item.userId === currentUserId) {
      // Leaving is always allowed, except when you are the last owner.
      return item.role === "owner" ? memberRows.filter((m) => m.role === "owner").length > 1 : true;
    }
    return canInvite && (isOwner || item.role !== "owner");
  };

  return (
    <>
      <SectionShell
        title="Members"
        hint="Everyone with access to this organization, and the role that decides what they can do"
      >
        <Card flush>
          <SectionView<OrganizationMemberSummary>
            section={members.section}
            rowKey={(item) => item.userId}
            onRetry={members.reload}
            emptyMessage="No members are recorded for this organization yet."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.userId}
                filterText={(item) => `${item.displayName ?? ""} ${item.email ?? ""} ${item.role}`}
                filterLabel="Filter members"
                columns={[
                  {
                    key: "member",
                    header: "Member",
                    render: (item) => (
                      <span>
                        {item.displayName ?? item.email ?? "Not yet signed in"}
                        {item.userId === currentUserId ? (
                          <span className="faint small"> (you)</span>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    key: "email",
                    header: "Email",
                    render: (item) =>
                      item.email ? (
                        <span className="mono small">{item.email}</span>
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                  {
                    key: "role",
                    header: "Role",
                    render: (item) => <StatusBadge label={roleLabel(item.role)} tone="neutral" />,
                  },
                  {
                    key: "since",
                    header: "Added",
                    render: (item) => <Timestamp value={item.createdAt} />,
                  },
                  {
                    key: "actions",
                    header: "",
                    render: (item) => (
                      <div className="row">
                        <Button
                          size="sm"
                          disabled={!canChangeRole(item)}
                          title={
                            item.userId === currentUserId
                              ? "You cannot change your own role."
                              : item.role === "owner" && !isOwner
                                ? "Only an owner can change an owner's role."
                                : undefined
                          }
                          onClick={() => setEditing(item)}
                        >
                          Change role
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={!canRemove(item)}
                          title={
                            item.role === "owner" && !isOwner && item.userId !== currentUserId
                              ? "Only an owner can remove an owner."
                              : undefined
                          }
                          onClick={() => setRemoving(item)}
                        >
                          {item.userId === currentUserId ? "Leave" : "Remove"}
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            )}
          />
        </Card>
        <p className="muted small" style={{ marginTop: "var(--space-3)" }}>
          {canInvite
            ? "Changing a role and removing a member take effect immediately. A member can always remove themselves, which is how you leave an organization. The last owner cannot be demoted or removed, and nobody can change their own role — promotion needs a second party."
            : "Your role can see this list but not change it. Changing roles and removing members needs the admin role; leaving the organization is always available to you."}
        </p>
      </SectionShell>

      <ChangeMemberRoleModal
        organizationId={organizationId}
        member={editing}
        canGrantOwner={isOwner}
        onClose={() => setEditing(null)}
        onChanged={() => {
          setEditing(null);
          members.reload();
        }}
      />
      <RemoveMemberModal
        organizationId={organizationId}
        member={removing}
        self={removing !== null && removing.userId === currentUserId}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          members.reload();
        }}
      />
    </>
  );
}

/**
 * Change a member's role.
 *
 * Only the roles the caller could actually grant are offered: an admin sees
 * admin/member/viewer, an owner additionally sees owner. The server is the
 * authority — this modal narrows the choice, it does not replace the guard.
 */
function ChangeMemberRoleModal({
  organizationId,
  member,
  canGrantOwner,
  onClose,
  onChanged,
}: {
  readonly organizationId: string;
  readonly member: OrganizationMemberSummary | null;
  readonly canGrantOwner: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const { client } = useApp();
  const [role, setRole] = useState<OrganizationMemberSummary["role"]>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: readonly OrganizationMemberSummary["role"][] = canGrantOwner
    ? ["owner", "admin", "member", "viewer"]
    : ["admin", "member", "viewer"];

  const submit = async () => {
    if (!member) return;
    setBusy(true);
    setError(null);
    const response = await updateMemberRole(client, {
      organizationId,
      memberId: member.userId,
      role,
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The role could not be changed.");
      return;
    }
    onChanged();
  };

  return (
    <Modal
      title="Change role"
      open={member !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Save role
          </Button>
        </>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        {member?.displayName ?? member?.email ?? "This member"} currently has the{" "}
        {member ? roleLabel(member.role) : ""} role.
      </p>
      <div className="row" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
        {options.map((option) => (
          <Button
            key={option}
            variant={role === option ? "primary" : "default"}
            size="sm"
            onClick={() => setRole(option)}
          >
            {roleLabel(option)}
          </Button>
        ))}
      </div>
      {error ? (
        <p className="small" style={{ color: "var(--color-danger)", marginBottom: 0 }}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** Remove a member, or leave the organization. */
function RemoveMemberModal({
  organizationId,
  member,
  self,
  onClose,
  onRemoved,
}: {
  readonly organizationId: string;
  readonly member: OrganizationMemberSummary | null;
  readonly self: boolean;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!member) return;
    setBusy(true);
    setError(null);
    const response = await removeMember(client, { organizationId, memberId: member.userId });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The member could not be removed.");
      return;
    }
    onRemoved();
  };

  return (
    <Modal
      title={self ? "Leave organization" : "Remove member"}
      open={member !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} busy={busy}>
            {self ? "Leave" : "Remove"}
          </Button>
        </>
      }
    >
      <p className="small" style={{ marginTop: 0 }}>
        {self
          ? "You will lose access to this organization immediately. Your membership row is deleted; your other organizations are unaffected."
          : `${member?.displayName ?? member?.email ?? "This member"} loses access to this organization immediately. The membership row is deleted; their other organizations are unaffected.`}
      </p>
      {error ? (
        <p className="small" style={{ color: "var(--color-danger)", marginBottom: 0 }}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** A membership role, spelled for a reader. */
function roleLabel(role: OrganizationMemberSummary["role"]): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "member":
      return "Member";
    case "viewer":
      return "Viewer";
  }
}
