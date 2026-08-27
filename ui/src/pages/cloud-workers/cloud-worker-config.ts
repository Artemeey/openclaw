import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAtHashSlug } from "@openclaw/normalization-core/string-normalization";

function profileRecords(config: Readonly<Record<string, unknown>> | null): Record<string, unknown> {
  const cloudWorkers = isRecord(config?.cloudWorkers) ? config.cloudWorkers : null;
  return isRecord(cloudWorkers?.profiles) ? cloudWorkers.profiles : {};
}

export function readCloudWorkerProfiles(config: Readonly<Record<string, unknown>> | null) {
  return Object.entries(profileRecords(config))
    .map(([id, profile]) => ({
      id,
      providerId: isRecord(profile) ? (normalizeOptionalString(profile.provider) ?? "") : "",
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

export function nextCloudWorkerProfileId(
  name: string,
  config: Readonly<Record<string, unknown>> | null,
) {
  // SetupId is ASCII and capped at 128 characters; leave room for a numeric suffix.
  let base =
    normalizeAtHashSlug(name)
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 96)
      .replace(/^-+|-+$/g, "") || "cloud";
  if (base === "constructor" || base === "prototype") {
    base = `cloud-${base}`;
  }
  const profiles = profileRecords(config);
  let id = base;
  for (let suffix = 2; Object.hasOwn(profiles, id); suffix += 1) {
    id = `${base}-${suffix}`;
  }
  return id;
}

export function buildCloudWorkerDeletePatch(
  config: Readonly<Record<string, unknown>>,
  profileId: string,
): { patch: Record<string, unknown> } | { error: "profileMissing" } {
  if (!Object.hasOwn(profileRecords(config), profileId)) {
    return { error: "profileMissing" };
  }
  const cloudWorkers = isRecord(config.cloudWorkers) ? config.cloudWorkers : null;
  const projectProfiles = isRecord(cloudWorkers?.projectProfiles)
    ? cloudWorkers.projectProfiles
    : {};
  const removedProjectProfiles = Object.fromEntries(
    Object.entries(projectProfiles)
      .filter(([, target]) => target === profileId)
      .map(([project]) => [project, null]),
  );
  // Merge-patch only the profile and its project defaults. Saved connections,
  // secrets, and all other provider-owned configuration remain available for cleanup.
  return {
    patch: {
      cloudWorkers: {
        profiles: { [profileId]: null },
        ...(Object.keys(removedProjectProfiles).length
          ? { projectProfiles: removedProjectProfiles }
          : {}),
      },
    },
  };
}
