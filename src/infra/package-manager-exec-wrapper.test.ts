import { describe, expect, it } from "vitest";
import { hasKnownPackageManagerExecContextOptions } from "./package-manager-exec-wrapper.js";

describe("hasKnownPackageManagerExecContextOptions", () => {
  it.each([
    ["leading", "continues after a terminator", [[["npx", "--", "--workspace=app"], true]]],
    ["leading", "stops at a positional token", [[["npx", "tsx", "--workspace=app"], false]]],
    ["leading", "stops at an unknown option", [[["npx", "--unknown", "--workspace=app"], false]]],
    ["leading", "matches context before generic options", [[["npx", "--package=tsx"], true]]],
    [
      "leading",
      "skips inline generic values",
      [[["npx", "--loglevel=silent", "--workspace=app"], true]],
    ],
    [
      "leading",
      "skips separate generic values",
      [[["npx", "--loglevel", "silent", "--workspace=app"], true]],
    ],
    [
      "leading",
      "skips missing generic values",
      [[["npx", "--loglevel", "--workspace=app"], false]],
    ],
    [
      "leading",
      "matches only exact uppercase -C",
      [
        [["npx", "-C", "./package"], true],
        [["npx", "-c", "./package"], false],
      ],
    ],
    ["leading", "does not split short clusters", [[["npx", "-pw"], false]]],
    [
      "before-terminator",
      "stops at a terminator",
      [[["npm", "exec", "--", "--workspace=app"], false]],
    ],
    [
      "before-terminator",
      "continues after a positional token",
      [[["npm", "exec", "tsx", "--workspace=app"], true]],
    ],
    [
      "before-terminator",
      "continues after an unknown option",
      [[["npm", "exec", "--unknown", "--workspace=app"], true]],
    ],
    [
      "before-terminator",
      "matches context before generic options",
      [[["npm", "exec", "--package=tsx"], true]],
    ],
    [
      "before-terminator",
      "skips inline generic values",
      [[["npm", "exec", "--loglevel=silent", "--workspace=app"], true]],
    ],
    [
      "before-terminator",
      "skips separate generic values",
      [[["npm", "exec", "--loglevel", "silent", "--workspace=app"], true]],
    ],
    [
      "before-terminator",
      "skips missing generic values",
      [[["npm", "exec", "--loglevel", "--workspace=app"], false]],
    ],
    [
      "before-terminator",
      "matches only exact uppercase -C",
      [
        [["npm", "exec", "-C", "./package"], true],
        [["npm", "exec", "-c", "./package"], false],
      ],
    ],
    ["before-terminator", "does not split short clusters", [[["npm", "exec", "-pw"], false]]],
  ] as Array<[string, string, Array<[string[], boolean]>]>)(
    "%s scanner %s",
    (_mode, _name, checks) => {
      for (const [argv, expected] of checks) {
        expect(hasKnownPackageManagerExecContextOptions(argv)).toBe(expected);
      }
    },
  );
});
