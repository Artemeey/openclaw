---
summary: "Find the DingTalk team's external plugin, setup guide, and compatibility requirements"
read_when:
  - You want to connect OpenClaw to DingTalk
  - You need the DingTalk plugin's installation guide or compatibility status
title: "DingTalk"
---

The DingTalk team maintains the external
`@dingtalk-real-ai/dingtalk-connector` plugin for direct messages and group chats.
It connects through DingTalk's Stream API. The plugin is maintained outside
OpenClaw and is not bundled with the core install.

## Compatibility

DingTalk plugin **0.8.25** does not start with OpenClaw **2026.8.1-beta.3** or
the current 2026.8.1 source. It imports the removed
`openclaw/plugin-sdk/channel-runtime` entry point. Its declared
`openclaw >=2026.4.9` peer dependency does not capture this incompatibility.

Wait for a compatible DingTalk release before enabling it on those hosts.
DingTalk is not offered in OpenClaw's default onboarding catalog while this
published-package compatibility gap remains.

## Install and configure

Follow the [DingTalk plugin setup guide](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/README.en.md)
for supported host versions, QR authorization, and manual bot configuration.
Check the [published package](https://www.npmjs.com/package/@dingtalk-real-ai/dingtalk-connector)
and its release notes before installing or upgrading.

DingTalk credentials, permissions, access policies, and bot behavior belong to
the external plugin. Use its documentation for the installed version.
The plugin and channel ID are both `dingtalk-connector`.

For generic plugin lifecycle commands, see [Manage plugins](/plugins/manage-plugins).
