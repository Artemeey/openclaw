import { describe, expect, it } from "vitest";
import {
  validateWorkerSetupCheckParams,
  validateWorkerSetupDescribeParams,
  validateWorkerSetupInstallParams,
  validateWorkerSetupPrepareParams,
} from "../index.js";
import { lazyCompile } from "../protocol-validator.js";
import { WorkerSetupCredentialSchema } from "./worker-setup.js";

describe("worker setup public contracts", () => {
  const validateCredential = lazyCompile(WorkerSetupCredentialSchema);

  it("allows bounded HTTPS credential help links and rejects unsafe or malformed URLs", () => {
    const credential = { key: "apiKey", label: "API key", required: true };
    expect(validateCredential(credential)).toBe(true);
    expect(validateCredential({ ...credential, helpUrl: "https://example.test/keys" })).toBe(true);
    for (const helpUrl of [
      "http://example.test/keys",
      "javascript:alert(1)",
      "/keys",
      "",
      "https://",
      "https:///keys",
      "https://example.test/key space",
      `https://example.test/${"x".repeat(2048)}`,
    ]) {
      expect(validateCredential({ ...credential, helpUrl })).toBe(false);
    }
  });

  const prepare = {
    connectionId: "team",
    profileId: "sandbox",
    label: "Team sandbox",
    provider: "example",
    settings: {},
    credentials: { apiKey: { source: "store", provider: "default", id: "TEAM_KEY" } },
  };

  it("accepts saved references and rejects plaintext, malformed refs, and oversized credential maps", () => {
    expect(validateWorkerSetupPrepareParams(prepare)).toBe(true);
    for (const credentials of [
      { apiKey: "plaintext" },
      { apiKey: { source: "store", provider: "default", id: "../key" } },
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`key${index}`, prepare.credentials.apiKey]),
      ),
    ]) {
      expect(validateWorkerSetupPrepareParams({ ...prepare, credentials })).toBe(false);
    }
  });

  it("checks exactly one saved identity with no commands or credential input", () => {
    expect(validateWorkerSetupCheckParams({ profileId: "sandbox" })).toBe(true);
    expect(validateWorkerSetupCheckParams({ connectionId: "team" })).toBe(true);
    for (const input of [
      {},
      { profileId: "sandbox", connectionId: "team" },
      { connectionId: "team", command: "run" },
    ]) {
      expect(validateWorkerSetupCheckParams(input)).toBe(false);
    }
  });

  it.each([validateWorkerSetupDescribeParams, validateWorkerSetupInstallParams])(
    "accepts only an empty object for local setup actions",
    (validate) => {
      expect(validate({})).toBe(true);
      for (const input of [null, [], { provider: "example" }, { command: "run" }]) {
        expect(validate(input)).toBe(false);
      }
    },
  );
});
