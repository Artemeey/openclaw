import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";

/** fs.listDir uses INVALID_REQUEST for host filesystem errors; only stable errno markers prove stale input. */
function isMissingRestoredFolderError(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    /^(?:Error:\s+)?(?:ENOENT|ENOTDIR):/u.test(error.message)
  );
}

/** Owns pending folder validation so navigation and user edits retire old replies. */
export class RestoredFolderValidation {
  state: "none" | "checking" | "failed" = "none";
  private generation = 0;

  cancel() {
    this.generation += 1;
    this.state = "none";
  }

  check(
    snapshot: ApplicationGatewaySnapshot | undefined,
    folder: string,
    isAdmin: boolean,
    callbacks: {
      isCurrent: () => boolean;
      onFound: (listing: FsListDirResult) => void;
      onMissing: () => void;
      onFailure: () => void;
    },
  ) {
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client) {
      callbacks.onMissing();
      return;
    }
    const generation = ++this.generation;
    this.state = "checking";
    const isCurrent = () => generation === this.generation && callbacks.isCurrent();
    void client
      .request<FsListDirResult>("fs.listDir", { path: folder })
      .then((listing) => {
        if (!isCurrent()) {
          return;
        }
        this.state = "none";
        callbacks.onFound(listing);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        if (!isAdmin || isMissingRestoredFolderError(error)) {
          callbacks.onMissing();
        } else {
          this.state = "failed";
          callbacks.onFailure();
        }
      });
  }
}
