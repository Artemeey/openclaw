import { describe, expect, it } from "vitest";
import {
  postedSlackMessage,
  sendThroughRealSlack,
  valueButtons,
} from "./outbound-payload.test-helpers.js";

describe("Slack authored presentation delivery", () => {
  it.each([
    {
      name: "portable text",
      text: "Overview",
      presentation: { blocks: [{ type: "text" as const, text: "Overview" }] },
      blockTypes: ["section"],
      posts: 1,
      authoredSection: undefined,
    },
    {
      name: "equivalent rendered Markdown",
      text: "**Overview**",
      presentation: { blocks: [{ type: "text" as const, text: "*Overview*" }] },
      blockTypes: ["section"],
      posts: 1,
      authoredSection: undefined,
    },
    ...[false, true].flatMap((fallback) =>
      [true, false].map((escaped) => {
        const title = fallback
          ? "Overview with a title too long for Slack native chart rendering"
          : "Overview";
        return {
          name: `${fallback ? "literal fallback" : "native chart"}, escaped list: ${String(escaped)}`,
          text: `${title} (pie chart)\n${escaped ? "\\-" : "-"} Open: 5`,
          presentation: {
            blocks: [
              {
                type: "chart" as const,
                chartType: "pie" as const,
                title,
                segments: [{ label: "Open", value: 5 }],
              },
            ],
          },
          blockTypes: [
            ...(escaped ? [] : ["section"]),
            ...(fallback ? [] : ["data_visualization"]),
          ],
          posts: fallback && !escaped ? 2 : 1,
          authoredSection: escaped ? undefined : `${title} (pie chart)\n\n• Open: 5`,
        };
      }),
    ),
  ])(
    "preserves authored rendering beside $name",
    async ({ text, presentation, blockTypes, posts, authoredSection }) => {
      const { client } = await sendThroughRealSlack({
        payload: { text, presentation },
        renderText: text,
      });

      expect(client.chat.postMessage).toHaveBeenCalledTimes(posts);
      const messages = client.chat.postMessage.mock.calls.map((_, index) =>
        postedSlackMessage(client, index),
      );
      expect(
        messages
          .map((message) => message.text)
          .join("\n")
          .match(/Overview/gu),
      ).toHaveLength(authoredSection ? 2 : 1);
      const blocks = messages.flatMap((message) => message.blocks ?? []);
      expect(blocks.map((block) => block.type)).toEqual(blockTypes);
      if (authoredSection) {
        expect(blocks.find((block) => block.type === "section")?.text?.text).toBe(authoredSection);
      }
      const chart = presentation.blocks[0];
      if (chart?.type === "chart") {
        if (blockTypes.includes("data_visualization")) {
          expect(blocks.at(-1)).toEqual({
            type: "data_visualization",
            title: chart.title,
            chart: { type: "pie", segments: [{ label: "Open", value: 5 }] },
          });
        } else {
          expect(messages.at(-1)).toMatchObject({
            text: `${chart.title} (pie chart)\n- Open: 5`,
            mrkdwn: false,
          });
        }
      }
    },
  );

  it("recognizes rendered authored Markdown split across native sections", async () => {
    const text = "**First** Second";
    const { client } = await sendThroughRealSlack({
      payload: {
        text,
        channelData: {
          slack: {
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: "*First*" } },
              { type: "section", text: { type: "mrkdwn", text: "Second" } },
            ],
          },
        },
      },
      renderText: text,
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text)).toEqual([
      "*First*",
      "Second",
    ]);
  });

  it.each(
    ["*", "**"].flatMap((marker) =>
      [
        [
          {
            name: `literal fallback (${marker})`,
            payload: {
              text: `**${"x".repeat(151)}**`,
              presentation: { title: `${marker}${"x".repeat(151)}${marker}`, blocks: [] },
            },
            authoredSection: `*${"x".repeat(151)}*`,
            posts: 2,
          },
          {
            name: `plain_text header (${marker})`,
            payload: {
              text: "**Overview**",
              presentation: { title: `${marker}Overview${marker}`, blocks: [] },
            },
            authoredSection: "*Overview*",
            posts: 1,
          },
        ],
        ["section", "context"].map((type) => ({
          name: `plain_text ${type} (${marker})`,
          payload: {
            text: "**Overview**",
            channelData: {
              slack: {
                blocks: [
                  type === "section"
                    ? { type, text: { type: "plain_text", text: `${marker}Overview${marker}` } }
                    : {
                        type,
                        elements: [{ type: "plain_text", text: `${marker}Overview${marker}` }],
                      },
                ],
              },
            },
          },
          authoredSection: "*Overview*",
          posts: 1,
        })),
        [false, true].map((represented) => ({
          name: `mixed context with mrkdwn: ${String(represented)} (${marker})`,
          payload: {
            text: "Ready **Overview**",
            channelData: {
              slack: {
                blocks: [
                  {
                    type: "context",
                    elements: [
                      { type: "plain_text", text: "Ready" },
                      {
                        type: represented ? "mrkdwn" : "plain_text",
                        text: `${marker}Overview${marker}`,
                      },
                    ],
                  },
                ],
              },
            },
          },
          authoredSection: represented && marker === "*" ? undefined : "Ready *Overview*",
          posts: 1,
        })),
      ].flat(),
    ),
  )("preserves authored formatting beside $name", async ({ payload, authoredSection, posts }) => {
    const { client } = await sendThroughRealSlack({ payload, renderText: payload.text });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(posts);
    const sections = client.chat.postMessage.mock.calls.flatMap((_, index) =>
      (postedSlackMessage(client, index).blocks ?? [])
        .filter((block) => block.type === "section" && block.text?.type === "mrkdwn")
        .map((block) => block.text?.text),
    );
    expect(sections).toEqual(authoredSection ? [authoredSection] : []);
  });

  it("recognizes whitespace at actual portable chunk boundaries", async () => {
    const text = "a ".repeat(100) + "x".repeat(5_799) + " z";
    const { client } = await sendThroughRealSlack({
      payload: { text, presentation: { blocks: [{ type: "text", text }] } },
      renderText: text,
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const sections = postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text);
    expect(sections).toHaveLength(3);
    expect(sections?.join("")).toBe(text);
  });

  it.each([
    {
      name: "inline code",
      authored: "`printf 'a  b'`",
      rendered: "`printf 'a  b'`",
      fragments: ["`printf 'a", "b'`"],
    },
    {
      name: "fenced code",
      authored: "```\nprintf 'a  b'\n```",
      rendered: "```\nprintf 'a  b'\n```",
      fragments: ["```\nprintf 'a", "b'\n```"],
    },
    {
      name: "bold",
      authored: "**First Second**",
      rendered: "*First Second*",
      fragments: ["*First", "Second*"],
    },
    {
      name: "italic",
      authored: "*First Second*",
      rendered: "_First Second_",
      fragments: ["_First", "Second_"],
    },
    {
      name: "strikethrough",
      authored: "~~First Second~~",
      rendered: "~First Second~",
      fragments: ["~First", "Second~"],
    },
    {
      name: "link",
      authored: "[First Second](https://example.com)",
      rendered: "<https://example.com|First Second>",
      fragments: ["<https://example.com|First", "Second>"],
    },
    {
      name: "closed code",
      authored: "`code` Next",
      rendered: undefined,
      fragments: ["`code`", "Next"],
    },
    {
      name: "unmatched literal",
      authored: "cost * 2 Next",
      rendered: undefined,
      fragments: ["cost * 2", "Next"],
    },
  ])("respects native field boundaries for $name", async ({ authored, rendered, fragments }) => {
    const { client } = await sendThroughRealSlack({
      payload: {
        text: authored,
        presentation: { blocks: fragments.map((text) => ({ type: "text", text })) },
      },
      renderText: authored,
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text)).toEqual([
      ...(rendered ? [rendered] : []),
      ...fragments,
    ]);
  });

  it.each([
    {
      name: "context bold",
      type: "context",
      authored: "**First Second**",
      rendered: "*First Second*",
      fragments: ["*First", "Second*"],
    },
    {
      name: "context code",
      type: "context",
      authored: "`a b`",
      rendered: "`a b`",
      fragments: ["`a", "b`"],
    },
    {
      name: "section code",
      type: "section",
      authored: "```\na\nb\n```",
      rendered: "```\na\nb\n```",
      fragments: ["```\na", "b\n```"],
    },
    {
      name: "section bold",
      type: "section",
      authored: "**First\nSecond**",
      rendered: "*First\nSecond*",
      fragments: ["*First", "Second*"],
    },
    {
      name: "complete context formatting",
      type: "context",
      authored: "**First** Second",
      rendered: undefined,
      fragments: ["*First*", "Second"],
    },
    {
      name: "complete section code",
      type: "section",
      authored: "`a`\nb",
      rendered: undefined,
      fragments: ["`a`", "b"],
    },
  ])(
    "preserves text-object boundaries inside $name",
    async ({ type, authored, rendered, fragments }) => {
      const objects = fragments.map((text) => ({ type: "mrkdwn", text }));
      const block = type === "context" ? { type, elements: objects } : { type, fields: objects };
      const { client } = await sendThroughRealSlack({
        payload: { text: authored, channelData: { slack: { blocks: [block] } } },
        renderText: authored,
      });
      expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(postedSlackMessage(client, 0).blocks).toEqual([
        block,
        ...(rendered
          ? [{ type: "section", text: { type: "mrkdwn", text: rendered, verbatim: true } }]
          : []),
      ]);
    },
  );

  it.each(["inline", "fenced"])("preserves distinct authored %s code whitespace", async (kind) => {
    const wrap = (text: string) => (kind === "inline" ? `\`${text}\`` : `\`\`\`\n${text}\n\`\`\``);
    const authored = wrap("printf 'a  b'");
    const presented = wrap("printf 'a b'");
    const { client } = await sendThroughRealSlack({
      payload: { text: authored, presentation: { blocks: [{ type: "text", text: presented }] } },
      renderText: authored,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedSlackMessage(client, 0).blocks?.map((block) => block.text?.text)).toEqual([
      authored,
      presented,
    ]);
  });

  it("sends authored text represented by adjacent fallbacks once", async () => {
    const title = "x".repeat(151);
    const { client } = await sendThroughRealSlack({
      payload: {
        text: title,
        presentation: {
          title,
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Status", action: { type: "command", command: "/status" } }],
            },
          ],
        },
      },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(postedSlackMessage(client, 0)).toMatchObject({
      text: `${title}\n\n- Status: \`/status\``,
      mrkdwn: false,
    });
    expect(postedSlackMessage(client, 0).blocks).toBeUndefined();
  });

  it("packs represented authored text once at the native block limit", async () => {
    const { client } = await sendThroughRealSlack({
      payload: {
        text: "Overview",
        channelData: { slack: { blocks: Array.from({ length: 49 }, () => ({ type: "divider" })) } },
        presentation: {
          blocks: [{ type: "text", text: "Overview" }, valueButtons("Refresh", "refresh")],
        },
      },
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedSlackMessage(client, 0).blocks).toHaveLength(50);
    expect(postedSlackMessage(client, 1).blocks?.map((block) => block.type)).toEqual(["actions"]);
    const text = client.chat.postMessage.mock.calls
      .map((_, index) => postedSlackMessage(client, index).text ?? "")
      .join("\n");
    expect(text.match(/Overview/gu)).toHaveLength(1);
  });
});
