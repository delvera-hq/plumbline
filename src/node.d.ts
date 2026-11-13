// The project has no Node type definitions, so declare the Node modules the CLI reads. Only what it calls is declared.

declare module "node:util" {
  export function parseArgs(config: {
    args: string[];
    options: Record<string, { type: "string" | "boolean" }>;
    allowPositionals: boolean;
    strict: boolean;
  }): { values: Record<string, string | boolean | undefined>; positionals: string[] };
}

declare module "node:fs/promises" {
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}
