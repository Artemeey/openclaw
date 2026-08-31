import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { skillLibraryMockInitScript } from "../../scripts/control-ui-mock-skill-library.js";
import { buildSkillLibraryMock } from "../../ui/src/test-helpers/skill-library-fixtures.js";

function installPreview() {
  const responses = new Map<string, unknown>();
  const sent: Array<{ receiver: object; data: string }> = [];
  // A fresh class keeps the preview's intentional prototype interceptor local to each test.
  class PreviewSocket {
    send(data: string) {
      sent.push({ receiver: this, data });
    }
  }
  vm.runInNewContext(skillLibraryMockInitScript(), {
    URL,
    structuredClone,
    window: {
      location: { href: "http://localhost/?skillLibrary=collaborator" },
      WebSocket: PreviewSocket,
      openclawControlUiE2eGateway: {
        setMethodResponse(method: string, payload: unknown) {
          responses.set(method, payload);
        },
        deferNext() {
          throw new Error("Catalog reads must not defer a mutation.");
        },
      },
    },
  });
  const socket = new PreviewSocket();
  const request = (method: string) => {
    const data = JSON.stringify({
      type: "req",
      id: "preview-probe",
      method,
      params: { sessionKey: "agent:main:preview" },
    });
    socket.send(data);
    expect(sent.at(-1)).toEqual({ receiver: socket, data });
    return responses.get(method);
  };
  return { request, responses };
}

describe("skill library preview catalogs", () => {
  it.each(["commands.list", "chat.metadata"])("serves the selected pin through %s", (method) => {
    const { request } = installPreview();
    const [selected] = buildSkillLibraryMock();
    if (!selected) {
      throw new Error("Preview fixture requires a selected skill.");
    }
    const result = request(method);
    expect(result).toMatchObject({
      commands: [{ name: selected.entry.name, source: "skill", scope: "both" }],
    });
    if (method === "chat.metadata") {
      expect(result).toMatchObject({ models: [] });
    }
  });

  it("preserves unrelated Gateway responses and the originating socket", () => {
    const { request, responses } = installPreview();
    const health = { ok: true };
    responses.set("health", health);
    expect(request("health")).toBe(health);
  });
});
