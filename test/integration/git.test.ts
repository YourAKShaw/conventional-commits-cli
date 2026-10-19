import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generatedPaths } from "../../src/diff/filter.js";
import { commitWithMessage, lastMessagePath, loadLastMessage } from "../../src/git/commit.js";
import { getStagedChanges, stagedFingerprint } from "../../src/git/diff.js";
import { getRepo, recentSubjects } from "../../src/git/repo.js";
import { stage, unstage } from "../../src/git/staging.js";
import { getStatus } from "../../src/git/status.js";
import { createRepo, type TempRepo } from "../helpers/repo.js";

const repos: TempRepo[] = [];
const make = (opts?: { initialCommit?: boolean }) => {
  const r = createRepo(opts);
  repos.push(r);
  return r;
};
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

describe("repository inspection", () => {
  it("describes branch, unborn and detached states", async () => {
    const fresh = make({ initialCommit: false });
    const info = await getRepo(fresh.root);
    expect(info).toMatchObject({ branch: "main", unborn: true, detached: false, operation: null });
    expect(await recentSubjects(info, 5)).toEqual([]);

    const r = make();
    r.write("x.txt", "1");
    r.commitAll("feat: second");
    r.git("checkout", "-q", "--detach", "HEAD~1");
    const detached = await getRepo(r.root);
    expect(detached).toMatchObject({ branch: null, detached: true, unborn: false });
  });

  it("reports a friendly error outside a repository", async () => {
    await expect(getRepo(join(make().root, ".git"))).rejects.toThrow();
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    await expect(getRepo(mkdtempSync(join(tmpdir(), "ccli-nogit-")))).rejects.toThrow(
      /not inside a git repository/,
    );
  });

  it("detects a merge in progress", async () => {
    const r = make();
    r.git("checkout", "-q", "-b", "other");
    r.write("a.txt", "other\n");
    r.commitAll("feat: other");
    r.git("checkout", "-q", "main");
    r.write("a.txt", "main\n");
    r.commitAll("feat: main");
    try {
      r.git("merge", "other");
    } catch {
      // conflict expected
    }
    expect((await getRepo(r.root)).operation).toBe("merge");
    expect((await getStatus(await getRepo(r.root))).unmerged).toEqual(["a.txt"]);
  });
});

describe("staged changes", () => {
  it("captures adds, modifications, deletions, renames and binaries with unusual paths", async () => {
    const r = make();
    r.write("keep.txt", "one\ntwo\n");
    r.write("old name.txt", "rename me\nplease\nnow\n");
    r.write("gone.txt", "bye\n");
    r.commitAll("chore: base");
    r.write("keep.txt", "one\nTWO\nthree\n");
    r.git("mv", "old name.txt", "new näme.txt");
    r.git("rm", "-q", "gone.txt");
    r.write("img.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
    r.write("src/ünï code.ts", "export const x = 1;\n");
    r.git("add", "-A");
    const repo = await getRepo(r.root);
    const changes = await getStagedChanges(repo);
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]));
    expect(byPath["keep.txt"]).toMatchObject({ status: "M", added: 2, deleted: 1 });
    expect(byPath["keep.txt"]?.hunks[0]?.lines).toEqual([" one", "-two", "+TWO", "+three"]);
    expect(byPath["new näme.txt"]).toMatchObject({ status: "R", oldPath: "old name.txt" });
    expect(byPath["gone.txt"]).toMatchObject({ status: "D" });
    expect(byPath["img.bin"]).toMatchObject({ binary: true });
    expect(byPath["src/ünï code.ts"]).toMatchObject({ status: "A", added: 1 });
  });

  it("works before the first commit", async () => {
    const r = make({ initialCommit: false });
    r.write("a.ts", "x\n");
    r.git("add", "a.ts");
    const changes = await getStagedChanges(await getRepo(r.root));
    expect(changes.files).toHaveLength(1);
    expect(changes.files[0]).toMatchObject({ path: "a.ts", status: "A" });
  });

  it("fingerprint changes when the index changes", async () => {
    const r = make();
    r.write("a.txt", "1");
    r.git("add", "a.txt");
    const repo = await getRepo(r.root);
    const before = await stagedFingerprint(repo);
    expect(await stagedFingerprint(repo)).toBe(before);
    r.write("b.txt", "2");
    r.git("add", "b.txt");
    expect(await stagedFingerprint(repo)).not.toBe(before);
  });

  it("reads linguist-generated attributes", async () => {
    const r = make();
    r.write(".gitattributes", "gen/** linguist-generated\n");
    const repo = await getRepo(r.root);
    expect([...(await generatedPaths(repo, ["gen/a.ts", "src/b.ts"]))]).toEqual(["gen/a.ts"]);
  });
});

describe("staging", () => {
  it("stages tracked or all changes and can undo exactly that", async () => {
    const r = make();
    r.write("README.md", "changed\n");
    r.write("new file.txt", "new\n");
    const repo = await getRepo(r.root);
    let status = await getStatus(repo);
    const staged = await stage(repo, status, "tracked");
    expect(staged).toEqual(["README.md"]);
    status = await getStatus(repo);
    expect(status.staged.map((e) => e.path)).toEqual(["README.md"]);
    await unstage(repo, staged);
    expect((await getStatus(repo)).staged).toEqual([]);

    const all = await stage(repo, await getStatus(repo), "all");
    expect(all.sort()).toEqual(["README.md", "new file.txt"]);
    await unstage(repo, all);
    expect((await getStatus(repo)).staged).toEqual([]);
  });

  it("undoes staging before the first commit", async () => {
    const r = make({ initialCommit: false });
    r.write("a.txt", "1");
    const repo = await getRepo(r.root);
    const staged = await stage(repo, await getStatus(repo), { paths: ["a.txt"] });
    expect((await getStatus(repo)).staged).toHaveLength(1);
    await unstage(repo, staged);
    expect((await getStatus(repo)).staged).toHaveLength(0);
    expect((await getStatus(repo)).untracked).toEqual(["a.txt"]);
  });
});

describe("commitWithMessage", () => {
  it("commits the exact message, keeping lines that start with #", async () => {
    const r = make();
    r.write("a.txt", "1");
    r.git("add", "a.txt");
    const repo = await getRepo(r.root);
    const message = "fix(core): handle #123\n\n#123 was caused by a race.\n\nRefs: #123";
    const result = await commitWithMessage(repo, message);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/^[0-9a-f]+ fix\(core\): handle #123$/);
    expect(r.git("log", "-1", "--format=%B").trim()).toBe(message);
  });

  it("saves the message when a hook rejects the commit, and honours --no-verify", async () => {
    if (process.platform === "win32") return;
    const r = make();
    r.write(".git/hooks/commit-msg", "#!/bin/sh\necho 'rejected by hook' >&2\nexit 1\n");
    chmodSync(join(r.root, ".git/hooks/commit-msg"), 0o755);
    r.write("a.txt", "1");
    r.git("add", "a.txt");
    const repo = await getRepo(r.root);
    const failed = await commitWithMessage(repo, "feat: blocked");
    expect(failed.ok).toBe(false);
    expect(loadLastMessage(repo)).toBe("feat: blocked");
    const ok = await commitWithMessage(repo, "feat: allowed", ["--no-verify"]);
    expect(ok.ok).toBe(true);
    expect(existsSync(lastMessagePath(repo))).toBe(false);
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe("1");
  });
});
