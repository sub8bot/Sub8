import assert from "node:assert/strict";
import { AGENT_DATA_ROOT, agentDir } from "../../../packages/orchestration/dist/paths.js";
import { ensureLayout, layoutPaths } from "../../../server/memory.mjs";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function mockVm() {
  const dirs = [];
  const files = new Map();
  return {
    dirs,
    files,
    io: {
      async mkdirpInContainer(_c, dir) {
        dirs.push(dir);
      },
      async readFileFromContainer(_c, dest) {
        return files.get(dest) || "";
      },
      async writeFileToContainer(_c, dest, text) {
        files.set(dest, text);
      },
    },
  };
}

function bot(id, name) {
  return {
    id,
    name,
    description: `${name} on the shared computer.`,
    vm: { container: "desk-shared", status: "running" },
  };
}

/** One computer, two agents: shared /config/workspace, private memory shards. Live Docker stays SKIP in docker-desk. */
export async function run() {
  const pa = layoutPaths(bot(A, "Alpha"));
  const pb = layoutPaths(bot(B, "Beta"));
  assert.equal(pa.workspace, "/config/workspace");
  assert.equal(pb.workspace, pa.workspace);
  assert.equal(pa.workflows, pb.workflows);
  assert.equal(pa.projects, pb.projects);
  assert.notEqual(pa.root, pb.root);
  assert.equal(pa.root, agentDir(A));
  assert.equal(pb.root, `${AGENT_DATA_ROOT}/agents/${B}`);
  assert.notEqual(pa.memoryProfile, pb.memoryProfile);
  assert.notEqual(pa.userMemoryProfile, pb.userMemoryProfile);
  assert.doesNotMatch(pa.root, /\/home\/box/);

  const { files, io } = mockVm();
  await ensureLayout(bot(A, "Alpha"), io);
  await ensureLayout(bot(B, "Beta"), io);
  assert.ok(files.has(pa.profileJson));
  assert.ok(files.has(pb.profileJson));
  assert.ok(files.has(pa.memoryProfile));
  assert.ok(files.has(pb.memoryProfile));
  const profileA = JSON.parse(files.get(pa.profileJson));
  const profileB = JSON.parse(files.get(pb.profileJson));
  assert.equal(profileA.id, A);
  assert.equal(profileB.id, B);
  assert.match(files.get(pa.memoryProfile) || "", /Alpha/);
  assert.match(files.get(pb.memoryProfile) || "", /Beta/);
}
