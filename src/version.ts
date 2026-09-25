import { readFileSync } from 'node:fs';

interface PackageManifest {
  name: string;
  version: string;
}

/** Inlined by the GitHub Action bundle, which ships without package.json. */
declare const BUNDLED_MANIFEST: PackageManifest | undefined;

// Read at runtime so the reported version can never drift from package.json.
// The relative path is the same from src/ (tests) and dist/ (published build).
const manifest =
  typeof BUNDLED_MANIFEST === 'undefined'
    ? (JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ) as PackageManifest)
    : BUNDLED_MANIFEST;

export const PACKAGE_NAME = manifest.name;
export const VERSION = manifest.version;
export const TAGLINE = 'Break your Node.js service before production does.';
