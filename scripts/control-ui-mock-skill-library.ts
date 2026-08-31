import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../packages/gateway-protocol/src/index.ts";
import type { ModelCatalogEntry } from "../ui/src/api/types.ts";
import { buildSkillLibraryMock } from "../ui/src/test-helpers/skill-library-fixtures.ts";

/** Runs inside the isolated mock browser, after the generic Gateway fixture. */
function installSkillLibraryMock(
  seed: ReturnType<typeof buildSkillLibraryMock>,
  models: ModelCatalogEntry[],
): void {
  type Controls = {
    setMethodResponse(method: string, payload: unknown): void;
    deferNext(method: string): void;
    rejectDeferred(
      method: string,
      error: { code: string; message: string; details?: unknown },
    ): void;
  };
  const gateway = (window as Window & { openclawControlUiE2eGateway?: Controls })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const mode = new URL(window.location.href).searchParams.get("skillLibrary") ?? "shared";
  const solo = mode === "solo";
  const viewer = mode === "collaborator" ? "profile-bob" : "profile-alice";
  const entries = new Map(seed.map((read) => [read.entry.skillId, read]));
  const histories = new Map(
    seed.map((read) => [
      read.entry.skillId,
      new Map([[read.entry.revision, structuredClone(read)]]),
    ]),
  );
  const sessions = new Map<string, SkillsLibraryReadResult[]>();
  const pins = (sessionKey: string) => {
    let selected = sessions.get(sessionKey);
    if (!selected) {
      selected = mode === "collaborator" ? [structuredClone(seed[0])] : [];
      sessions.set(sessionKey, selected);
    }
    return selected;
  };
  const visible = () =>
    solo
      ? []
      : Array.from(entries.values())
          .map((read) => read.entry)
          .filter(
            (entry) =>
              !entry.removed &&
              (mode === "admin" ||
                entry.ownerProfileId === viewer ||
                entry.shared ||
                entry.ownerProfileId === null),
          );
  const selection = (read: SkillsLibraryReadResult) => ({
    skillId: read.entry.skillId,
    revision: read.entry.revision,
    name: read.entry.name,
    ownerProfileId: read.entry.ownerProfileId,
    slug: read.entry.slug,
    description: read.entry.description,
    ownerLabel: read.entry.ownerLabel,
  });
  const refresh = (sessionKey?: string) => {
    const selected = sessionKey ? pins(sessionKey) : [];
    const result: SkillsLibraryListResult = {
      entries: visible(),
      profileId: solo ? null : viewer,
      multipleProfiles: !solo,
      defaultTarget: solo ? "workspace" : "personal",
      canManageWorkspace: solo || mode === "admin",
      defaultSelectionLimit: 64,
      ...(sessionKey
        ? {
            session: {
              sessionKey,
              selections: selected.map(selection),
              attachable: visible().filter(
                (entry) => !selected.some((read) => read.entry.skillId === entry.skillId),
              ),
            },
          }
        : {}),
    };
    gateway.setMethodResponse("skills.library.list", result);
  };
  for (const read of entries.values()) {
    read.entry.canEdit =
      mode !== "readonly" && (mode === "admin" || read.entry.ownerProfileId === viewer);
  }
  refresh();
  // oxlint-disable-next-line typescript/unbound-method -- Capture native send before interception; every call below restores the originating socket with .call(this, data).
  const originalSend = window.WebSocket.prototype.send;
  window.WebSocket.prototype.send = function (data) {
    if (typeof data !== "string") {
      return originalSend.call(this, data);
    }
    const frame = JSON.parse(data) as {
      type?: string;
      method?: string;
      params?: {
        sessionKey?: string;
        skillId?: string;
        expectedRevision?: string | null;
        slug?: string;
        content?: string;
        files?: SkillsLibraryReadResult["files"];
        action?: string;
        revision?: string;
        source?: { slug: string };
      };
    };
    const method = frame.method;
    const params = frame.params;
    if (frame.type !== "req" || !method || !params) {
      return originalSend.call(this, data);
    }
    if (method === "commands.list" || method === "chat.metadata") {
      const selected = params.sessionKey ? pins(params.sessionKey) : [];
      gateway.setMethodResponse(method, {
        commands: selected.map(({ entry }) => ({
          name: entry.name,
          skillDisplayName: `${entry.slug} · ${entry.ownerLabel}`,
          description: entry.description,
          source: "skill",
          scope: "both",
          acceptsArgs: true,
          skillModelVisible: true,
          textAliases: [`/${entry.name}`],
        })),
        ...(method === "chat.metadata" ? { models } : {}),
      });
      return originalSend.call(this, data);
    }
    if (!method.startsWith("skills.library.")) {
      return originalSend.call(this, data);
    }
    const reject = (message: string, code = "SKILL_LIBRARY_FORBIDDEN") => {
      gateway.deferNext(method);
      originalSend.call(this, data);
      gateway.rejectDeferred(method, { code: "INVALID_REQUEST", message, details: { code } });
    };
    if (method === "skills.library.list") {
      refresh(params.sessionKey);
      return originalSend.call(this, data);
    }
    if (method === "skills.library.read") {
      const selected = params.sessionKey
        ? pins(params.sessionKey).find(
            (read) =>
              read.entry.skillId === params.skillId && read.entry.revision === params.revision,
          )
        : undefined;
      const read = params.sessionKey
        ? selected
        : params.skillId && visible().some((entry) => entry.skillId === params.skillId)
          ? params.revision
            ? histories.get(params.skillId)?.get(params.revision)
            : entries.get(params.skillId)
          : undefined;
      if (!read) {
        return reject("Read requires visible library access or an exact selected session pin.");
      }
      gateway.setMethodResponse(
        method,
        params.sessionKey
          ? {
              ...read,
              entry: { ...read.entry, canEdit: false },
              revisions: [{ revision: read.entry.revision, createdAt: read.entry.updatedAt }],
            }
          : {
              ...read,
              entry: {
                ...read.entry,
                canEdit: entries.get(read.entry.skillId)?.entry.canEdit === true,
              },
            },
      );
      return originalSend.call(this, data);
    }
    if (method === "skills.library.activate" && params.sessionKey) {
      const selected = pins(params.sessionKey);
      const targets =
        params.action === "refresh" && !params.skillId
          ? selected.map((read) => read.entry.skillId)
          : [params.skillId];
      if (
        params.action !== "detach" &&
        targets.some((id) => !visible().some((entry) => entry.skillId === id))
      ) {
        return reject(
          "Refresh requires current library access. The existing session pin remains unchanged.",
        );
      }
      let next = selected.filter((read) => read.entry.skillId !== params.skillId);
      if (params.action === "refresh" && !params.skillId) {
        next = [];
      }
      if (params.action !== "detach") {
        for (const id of targets) {
          const read = id
            ? params.revision
              ? histories.get(id)?.get(params.revision)
              : entries.get(id)
            : undefined;
          if (!read) {
            return reject("Skill revision is unavailable.");
          }
          next.push(structuredClone(read));
        }
      }
      sessions.set(params.sessionKey, next);
      refresh(params.sessionKey);
      gateway.setMethodResponse(method, {
        sessionKey: params.sessionKey,
        selections: next.map((read) => ({
          skillId: read.entry.skillId,
          revision: read.entry.revision,
          name: read.entry.name,
          ownerProfileId: read.entry.ownerProfileId,
        })),
        sessionActivation: "next-turn",
      });
      return originalSend.call(this, data);
    }
    if (
      !["skills.library.save", "skills.library.mutate", "skills.library.import"].includes(method)
    ) {
      return originalSend.call(this, data);
    }
    const current = params.skillId ? entries.get(params.skillId) : undefined;
    if (
      params.skillId &&
      (!current ||
        !current.entry.canEdit ||
        current.entry.revision !== params.expectedRevision ||
        mode === "conflict")
    ) {
      gateway.deferNext(method);
      originalSend.call(this, data);
      gateway.rejectDeferred(method, {
        code: "INVALID_REQUEST",
        message: "The skill changed. Reopen it to review the latest revision.",
        details: { code: "SKILL_LIBRARY_CONFLICT" },
      });
      return;
    }
    const skillId = current?.entry.skillId ?? crypto.randomUUID();
    const slug = params.slug ?? current?.entry.slug ?? "imported-skill";
    const revision =
      method === "skills.library.mutate"
        ? ((params.action === "rollback" ? params.revision : current?.entry.revision) ??
          "1".repeat(64))
        : String((current?.revisions.length ?? 0) + 1).padStart(64, "0");
    const previous =
      params.action === "rollback" && params.revision
        ? histories.get(skillId)?.get(params.revision)
        : undefined;
    const read: SkillsLibraryReadResult = current ?? {
      entry: {
        skillId,
        slug,
        name: `s_${slug.replaceAll("-", "_").slice(0, 9)}_${skillId.replaceAll("-", "").slice(0, 20)}`,
        description: "Custom skill",
        ownerProfileId: viewer,
        ownerLabel: viewer === "profile-alice" ? "Alice" : "Bob",
        authorProfileId: viewer,
        shared: false,
        enabled: true,
        removed: false,
        revision,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        canEdit: true,
      },
      content: "",
      files: [],
      revisions: [],
    };
    read.entry = { ...read.entry, slug, revision, updatedAt: Date.now() };
    if (method === "skills.library.save") {
      read.content = params.content ?? "";
      read.files = params.files ?? [];
    }
    if (method === "skills.library.import") {
      read.content = `---\nname: ${slug}\ndescription: Imported from ClawHub\n---\n\nImported ${params.source?.slug ?? slug}.\n`;
    }
    if (params.action === "remove") {
      read.entry.removed = true;
    }
    if (params.action === "share" || params.action === "unshare") {
      read.entry.shared = params.action === "share";
    }
    if (params.action === "enable" || params.action === "disable") {
      read.entry.enabled = params.action === "enable";
    }
    if (params.action === "transfer") {
      read.entry.ownerProfileId = null;
      read.entry.ownerLabel = "Team";
      read.entry.shared = true;
    }
    if (previous) {
      read.content = previous.content;
      read.files = structuredClone(previous.files);
    }
    if (!read.revisions.some((item) => item.revision === revision)) {
      read.revisions = [{ revision, createdAt: Date.now() }, ...read.revisions];
    }
    entries.set(skillId, read);
    const history = histories.get(skillId) ?? new Map();
    history.set(revision, structuredClone(read));
    histories.set(skillId, history);
    refresh();
    gateway.setMethodResponse(method, {
      state: read.entry.removed ? "removed" : "published",
      target: read.entry.ownerProfileId === null ? "team" : "personal",
      entry: read.entry,
      sessionActivation: "new-sessions",
      nextAction: read.entry.removed
        ? "Existing sessions retain their pinned revision. Create a new skill to add it to future sessions."
        : !read.entry.enabled
          ? "Disabled for new-session defaults. Existing sessions retain their selected revision; explicit attachment remains available."
          : `Enabled for ${read.entry.shared || read.entry.ownerProfileId === null ? "new team sessions" : "your new sessions"}, subject to agent policy and prerequisites. Existing session pins remain. Use skills.library.activate to attach or refresh it.`,
    });
    return originalSend.call(this, data);
  };
}

export function skillLibraryMockInitScript(models: ModelCatalogEntry[] = []): string {
  return `(() => { const __name = (target) => target; (${installSkillLibraryMock.toString()})(${JSON.stringify(buildSkillLibraryMock())}, ${JSON.stringify(models)}); })();`;
}
