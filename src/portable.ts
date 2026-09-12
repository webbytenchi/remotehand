export const PORTABLE_DIRECTORIES = [
  "config",
  "data",
  "layouts",
  "themes",
  "logs",
] as const;

export type PortableDirectory = (typeof PORTABLE_DIRECTORIES)[number];

export interface PortablePaths {
  root: string;
  config: string;
  data: string;
  layouts: string;
  themes: string;
  logs: string;
}

export function joinPortablePath(
  root: string,
  child: PortableDirectory,
): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]$/, "")}${separator}${child}`;
}

export function derivePortablePaths(root: string): PortablePaths {
  return {
    root,
    config: joinPortablePath(root, "config"),
    data: joinPortablePath(root, "data"),
    layouts: joinPortablePath(root, "layouts"),
    themes: joinPortablePath(root, "themes"),
    logs: joinPortablePath(root, "logs"),
  };
}
