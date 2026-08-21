import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  planDockerInstall,
  colimaStartArgs,
  dockerStaticArch,
  dockerCliIndexUrl,
  colimaBinaryName,
  limaArchiveName,
  dockerDesktopInstallerUrl,
  dockerDocsUrl,
  sub8BinDir,
  hostPathDirs,
  pickLatestDockerTarball,
  BREW_DOCKER_PACKAGES,
} from "../server/vm.mjs";

function plan(facts) {
  return planDockerInstall(facts);
}

assert.deepEqual(BREW_DOCKER_PACKAGES, ["colima", "docker"]);
assert.ok(!BREW_DOCKER_PACKAGES.includes("docker-desktop"));

assert.equal(plan({ platform: "darwin", cli: true, daemon: true }).action, "noop");
assert.equal(plan({ platform: "win32", cli: true, daemon: true }).action, "noop");
assert.equal(plan({ platform: "linux", cli: true, daemon: true }).action, "noop");

assert.equal(plan({ platform: "darwin", cli: true, daemon: false, colima: true }).action, "recover");
assert.equal(plan({ platform: "darwin", cli: true, daemon: false, desktop: true }).action, "recover");
assert.equal(plan({ platform: "win32", cli: true, daemon: false, desktop: true }).action, "recover");
assert.equal(plan({ platform: "linux", cli: true, daemon: false }).action, "recover");

assert.equal(plan({ platform: "darwin", cli: false, daemon: false, brew: true, desktop: false }).action, "brew-colima");
assert.deepEqual(plan({ platform: "darwin", cli: false, brew: true }).packages, ["colima", "docker"]);
assert.equal(plan({ platform: "darwin", cli: false, brew: true }).engine, "colima");

assert.equal(plan({ platform: "darwin", cli: false, brew: false, desktop: false }).action, "static-colima");
assert.equal(plan({ platform: "darwin", cli: false, brew: false }).dest, "sub8-bin");

assert.equal(plan({ platform: "darwin", cli: false, brew: true, desktop: true }).action, "start-desktop");
assert.equal(plan({ platform: "darwin", cli: false, brew: false, desktop: true }).engine, "desktop");

const macPlans = [
  plan({ platform: "darwin", cli: false, brew: true }),
  plan({ platform: "darwin", cli: false, brew: false }),
  plan({ platform: "darwin", cli: false, desktop: true }),
];
for (const p of macPlans) {
  assert.notEqual(p.action, "download-desktop");
  assert.notEqual(p.action, "winget-desktop");
  assert.ok(!(p.packages || []).includes("docker-desktop"));
}

assert.equal(plan({ platform: "linux", cli: false, daemon: false }).action, "engine-get-docker");
assert.equal(plan({ platform: "linux", cli: false }).engine, "moby");

assert.equal(plan({ platform: "win32", cli: false, desktop: true, winget: true }).action, "start-desktop");
assert.equal(plan({ platform: "win32", cli: false, desktop: false, winget: true }).action, "winget-desktop");
assert.equal(plan({ platform: "win32", cli: false, desktop: false, winget: true }).package, "Docker.DockerDesktop");
assert.equal(plan({ platform: "win32", cli: false, desktop: false, winget: false }).action, "download-desktop");
assert.equal(plan({ platform: "win32", cli: false, desktop: false }).engine, "desktop");

assert.equal(plan({ platform: "freebsd", cli: false }).action, "unsupported");

const tiny = colimaStartArgs({ cpus: 4, totalMemBytes: 8 * 1024 ** 3 });
assert.equal(tiny.cpu, 2);
assert.equal(tiny.memory, 2);

const mid = colimaStartArgs({ cpus: 8, totalMemBytes: 16 * 1024 ** 3 });
assert.equal(mid.cpu, 4);
assert.equal(mid.memory, 4);

const big = colimaStartArgs({ cpus: 12, totalMemBytes: 32 * 1024 ** 3 });
assert.equal(big.cpu, 4);
assert.equal(big.memory, 8);

assert.equal(dockerStaticArch("arm64"), "aarch64");
assert.equal(dockerStaticArch("x64"), "x86_64");
assert.equal(dockerCliIndexUrl("darwin", "arm64"), "https://download.docker.com/mac/static/stable/aarch64/");
assert.equal(dockerCliIndexUrl("darwin", "x64"), "https://download.docker.com/mac/static/stable/x86_64/");
assert.equal(colimaBinaryName("darwin", "arm64"), "colima-Darwin-arm64");
assert.equal(colimaBinaryName("darwin", "x64"), "colima-Darwin-x86_64");
assert.equal(limaArchiveName("v2.2.0", "darwin", "arm64"), "lima-2.2.0-Darwin-arm64.tar.gz");
assert.equal(limaArchiveName("2.2.0", "darwin", "x64"), "lima-2.2.0-Darwin-x86_64.tar.gz");
assert.match(dockerDesktopInstallerUrl("win32", "x64"), /desktop\.docker\.com\/win\/main\/amd64\/Docker%20Desktop%20Installer\.exe/);
assert.match(dockerDesktopInstallerUrl("win32", "arm64"), /\/arm64\//);
assert.equal(dockerDesktopInstallerUrl("darwin"), "");
assert.match(dockerDocsUrl("linux"), /engine\/install/);
assert.match(dockerDocsUrl("win32"), /windows-install/);
assert.match(dockerDocsUrl("darwin"), /mac-install/);

const listing = `
<a href="docker-27.5.1.tgz">docker-27.5.1.tgz</a>
<a href="docker-28.3.3.tgz">docker-28.3.3.tgz</a>
<a href="docker-28.3.2.tgz">docker-28.3.2.tgz</a>
<a href="docker-rootless-extras-28.3.3.tgz">docker-rootless-extras-28.3.3.tgz</a>
`;
assert.equal(pickLatestDockerTarball(listing), "docker-28.3.3.tgz");
assert.equal(pickLatestDockerTarball(""), "");

const home = "/tmp/sub8-home";
assert.equal(sub8BinDir(home), path.join(home, ".sub8", "bin"));
assert.ok(hostPathDirs(home).includes(path.join(home, ".sub8", "bin")));
assert.ok(hostPathDirs(home).includes(path.join(home, ".docker", "bin")));
if (process.platform !== "win32") {
  assert.ok(hostPathDirs(os.homedir()).includes("/opt/homebrew/bin"));
}

console.log("ok docker-install");
