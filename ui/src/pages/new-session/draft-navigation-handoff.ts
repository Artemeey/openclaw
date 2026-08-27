import type { ApplicationContext } from "../../app/context.ts";
import * as catalog from "./catalog-target.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";

export type NewSessionNavigationDraft = {
  place: ReturnType<typeof capturePlaceDraft>;
  visibility: DraftSubmissionFlow["visibility"];
  toolOverrides: DraftSubmissionFlow["capabilities"]["toolOverrides"];
  permissionMode: DraftSubmissionFlow["permission"]["value"];
};

function capturePlaceDraft(place: DraftPlaceState) {
  return {
    agentId: place.agentId,
    folder: place.folder,
    deviceId: place.deviceId,
    autoDevice: place.autoDevice,
    profileId: place.cloudProfileId,
    machines: place.cloudMachines.capture(),
    projectId: place.browser.projectId,
    remoteProject: place.browser.remoteProject,
    worktree: place.worktree,
    baseRef: place.baseRef,
    worktreeName: place.worktreeName,
    model: place.modelControl.selected,
    thinkingLevel: place.modelControl.thinkingLevel,
    contextWindow: place.modelControl.contextWindow,
  };
}

/** Only route identity crosses the URL boundary; draft contents stay in the handoff. */
export function cloudSetupSearch(search: string): string {
  const params = new URLSearchParams(cloudSetupSessionSearch(search));
  params.set("returnTo", "new-session");
  return `?${params}`;
}

export function cloudSetupSessionSearch(search: string, profileId?: string): string {
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const key of ["agent", "catalog", "group"]) {
    const value = source.get(key);
    if (value) {
      params.set(key, value);
    }
  }
  if (profileId) {
    params.set("cloudProfile", profileId);
  }
  return params.size ? `?${params}` : "";
}

const NEW_SESSION_DRAFT_PANE_ID = "new-session-draft";

export function retainDraft(
  context: ApplicationContext | undefined,
  submission: DraftSubmissionFlow,
  openedFor: string | null,
  messageOwnerKey: string,
  place: DraftPlaceState,
) {
  submission.draftPersistence.persistNow();
  const owner = context?.gateway.snapshot.client;
  if (!context || !owner || submission.submitting || submission.pendingPlacement.sessionKey) {
    return;
  }
  const routeKey = openedFor ?? catalog.routeKeyFromSearch(window.location.search);
  context.chatAttachmentHandoff.prepare({
    owner,
    paneId: NEW_SESSION_DRAFT_PANE_ID,
    scopeKey: routeKey,
    message: messageOwnerKey === routeKey ? submission.message : "",
    attachments: submission.attachmentDraft.take(),
    fallbacks: {},
    newSessionDraft: {
      place: capturePlaceDraft(place),
      visibility: submission.visibility,
      toolOverrides: submission.capabilities.toolOverrides,
      permissionMode: submission.permission.value,
    },
  });
}

export function restoreDraft(
  context: ApplicationContext | undefined,
  submission: DraftSubmissionFlow,
  routeKey: string,
  ownedMessage: string,
  place: DraftPlaceState,
) {
  submission.draftPersistence.selectRoute(routeKey);
  const owner = context?.gateway.snapshot.client;
  const draft =
    context && owner
      ? context.chatAttachmentHandoff.consume({
          owner,
          paneId: NEW_SESSION_DRAFT_PANE_ID,
          scopeKey: routeKey,
        })
      : null;
  if (draft) {
    submission.restoreDraftState({
      message: ownedMessage || draft.message || "",
      attachments: draft.attachments,
      visibility: draft.newSessionDraft?.visibility ?? submission.visibility,
      ...(draft.newSessionDraft
        ? {
            toolOverrides: draft.newSessionDraft.toolOverrides,
            permissionMode: draft.newSessionDraft.permissionMode,
          }
        : {}),
    });
    if (draft.newSessionDraft) {
      place.restoreNavigationState(draft.newSessionDraft.place);
    }
  } else if (ownedMessage) {
    submission.restoreMessage(ownedMessage);
  }
  place.restoreCloudSetupDestination(
    new URLSearchParams(window.location.search).get("cloudProfile") ?? "",
  );
  activateDraft(submission, routeKey);
  return routeKey;
}

export function activateDraft(submission: DraftSubmissionFlow, routeKey: string) {
  if (!submission.pendingPlacement.sessionKey) {
    submission.draftPersistence.activateRoute(routeKey);
  }
}

export function restoreDraftOwner(
  submission: DraftSubmissionFlow,
  gatewayUrl: string,
  recoveryScope: string,
) {
  submission.restorePendingPlacementRecovery(gatewayUrl, recoveryScope);
  submission.draftPersistence.setOwner(
    gatewayUrl,
    recoveryScope,
    Boolean(submission.pendingPlacement.sessionKey),
  );
}
