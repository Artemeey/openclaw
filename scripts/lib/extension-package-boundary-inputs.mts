// Fixed inheritance chain for plugins opting into package-boundary compilation.
export const EXTENSION_BOUNDARY_CONFIG_INPUTS = [
  "tsconfig.json",
  "extensions/tsconfig.package-boundary.base.json",
  "extensions/tsconfig.package-boundary.paths.json",
] as const;
