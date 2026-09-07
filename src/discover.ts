/**
 * Discover transcript files under ~/.claude/projects.
 *
 * Mirrors the oracle's file collection so parity tests see identical inputs:
 *   - default: every *.jsonl under every project dir (all-time / all-projects)
 *   - --project <path>: if it is a dir containing *.jsonl, use it directly;
 *     else encode the cwd (replace [/.] with '-') and look under projects root;
 *     else treat the raw string as a project-dir name under the root.
 *
 * Read-only: this module never writes and never touches anything but listing.
 */

import { existsSync, readdirSync, statSync, realpathSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function projectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

/** Encode a cwd path the way Claude Code names project dirs (oracle-compatible). */
export function encodeCwd(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    real = path;
  }
  return real.replace(/[/.]/g, "-");
}

/** Recursively collect transcripts, including session/subagents/*.jsonl. */
function jsonlIn(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    // Deliberately do not follow symlinked directories: a project transcript
    // tree should never escape its selected root or recurse through a cycle.
    else if (entry.isDirectory()) files.push(...jsonlIn(path));
  }
  return files;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface DiscoverResult {
  files: string[];
  roots: string[];
  /** encoded-cwd basename per file, for project labeling. */
  projectOf: (file: string) => string;
}

/**
 * @param project  --project value (a cwd path or an encoded project-dir name).
 *                 undefined => all projects.
 * @param home     overridable for tests.
 */
export function discover(project: string | undefined, home: string = homedir()): DiscoverResult {
  const root = projectsRoot(home);
  let roots: string[];

  if (project) {
    const expanded = project.startsWith("~")
      ? join(home, project.slice(1))
      : project;
    if (isDir(expanded) && jsonlIn(expanded).length > 0) {
      roots = [expanded];
    } else {
      const cand = join(root, encodeCwd(expanded));
      if (isDir(cand)) roots = [cand];
      else roots = [join(root, project)];
    }
  } else if (isDir(root)) {
    roots = readdirSync(root)
      .map((n) => join(root, n))
      .filter((p) => isDir(p));
  } else {
    roots = [];
  }

  const files: string[] = [];
  const fileRoot = new Map<string, string>();
  for (const r of roots) {
    for (const f of jsonlIn(r)) {
      files.push(f);
      fileRoot.set(f, r);
    }
  }
  // Deterministic order. Cross-file duplicate `message.id`s are resolved
  // first-occurrence-wins, so iteration order decides which session a shared
  // turn is attributed to. Raw readdir/glob order is filesystem-dependent and
  // NOT reproducible; sorting by full path makes results stable across runs and
  // machines. The oracle-parity test runs the oracle over this same sorted
  // order so the two agree exactly (see test/oracle-parity.test.ts).
  files.sort();

  const rootBase = (r: string): string => {
    const idx = r.lastIndexOf("/");
    return idx >= 0 ? r.slice(idx + 1) : r;
  };

  return {
    files,
    roots,
    projectOf: (file: string) => {
      const r = fileRoot.get(file);
      return r ? rootBase(r) : "";
    },
  };
}

export function projectsRootExists(home: string = homedir()): boolean {
  return existsSync(projectsRoot(home));
}
