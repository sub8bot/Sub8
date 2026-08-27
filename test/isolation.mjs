import assert from "node:assert/strict";
import { assertVmShell, isHostPath, requireVm } from "../server/isolation.mjs";
import { readFileSync } from "node:fs";
import * as pkg from "@sub8/constants";

let fails = 0;
const ok = (name, fn) => {
  try {
    fn();
    console.log("PASS", name);
  } catch (err) {
    fails += 1;
    console.log("FAIL", name, "-", err.message);
  }
};

// The versioned binary names are the ones anyone would actually type, and
// \bsqlite\b does NOT match "sqlite3" — the trailing digit kills the word
// boundary. The guard blocked "sqlite" and let "sqlite3" through.
ok("cookie dump is blocked under the real binary names", () => {
  for (const cmd of [
    "sqlite3 ~/chrome-desk/Default/Cookies .dump",
    "sqlite ~/chrome-desk/Default/Cookies .dump",
    "python3 -c 'import sqlite3' ~/Login Data",
    "python -c 'import sqlite3' ~/Login Data",
    "cat ~/.secrets",
    "strings ~/chrome-desk/Default/Cookies",
  ]) {
    assert.throws(() => assertVmShell(cmd), /cookies or secrets/, cmd);
  }
});

ok("ordinary desk work still runs", () => {
  for (const cmd of [
    "python3 /config/workspace/hello.py",
    "sqlite3 /config/app.db .tables",
    "ls -la /config",
    "cat /config/workspace/notes.txt",
    "",
  ]) {
    assert.doesNotThrow(() => assertVmShell(cmd), String(cmd));
  }
});

ok("host paths and synthetic input stay blocked", () => {
  assert.throws(() => assertVmShell("cat /Users/someone/.ssh/id_rsa"), /host paths/);
  assert.throws(() => assertVmShell("xdotool key Return"), /do not click or type/);
  assert.throws(() => assertVmShell("curl 127.0.0.1:9222/json/new"), /debug port/);
  assert.equal(isHostPath("/Users/someone"), true);
  assert.equal(isHostPath("/config/workspace"), false);
});

ok("requireVm refuses anything that is not a bot computer", () => {
  assert.equal(requireVm({ vm: { container: "localbot-abc" } }), "localbot-abc");
  assert.throws(() => requireVm({ vm: { container: "postgres" } }, "shell"), /shell blocked/);
});


// server/vm.mjs does `docker cp server/isolation.mjs <container>:/usr/local/lib/
// sub8/isolation.mjs` — this file is shipped INTO every container as a single
// standalone file with no node_modules beside it. So it must never grow an
// import. That is also why it cannot simply re-export @sub8/constants: the copy
// inside the container would fail to resolve the specifier, and the guard would
// die exactly where it matters most.
ok("isolation stays import-free so the container copy keeps working", () => {
  const src = readFileSync(new URL("../server/isolation.mjs", import.meta.url), "utf8");
  const imports = src.match(/^\s*import\s.+$/gm) || [];
  assert.deepEqual(imports, [], `isolation.mjs must have no imports, found: ${imports.join(" | ")}`);
  assert.equal(/\brequire\s*\(/.test(src), false, "isolation.mjs must not use require() either");
});

// The same three guards live in @sub8/constants for callers that CAN resolve a
// package. Two copies of one security rule is exactly how the sqlite3 bypass
// happened, so pin them to identical behaviour instead of trusting a comment.
ok("server/isolation and @sub8/constants agree on every case", () => {
  const verdict = (fn, arg) => {
    try {
      fn(arg);
      return "allow";
    } catch (err) {
      return `throw:${err.message}`;
    }
  };
  for (const c of [
    "sqlite3 ~/chrome-desk/Default/Cookies .dump",
    "sqlite ~/chrome-desk/Default/Cookies .dump",
    "python3 -c 'import sqlite3' ~/Login Data",
    "cat ~/.secrets",
    "strings ~/chrome-desk/Default/Cookies",
    "hexdump -C ~/Login Data",
    "dd if=~/chrome-desk/Default/Cookies",
    "cp ~/chrome-desk/Default/Cookies /tmp/x",
    "python3 /config/workspace/hello.py",
    "sqlite3 /config/app.db .tables",
    "ls -la /config",
    "",
    "cat /Users/someone/.ssh/id_rsa",
    "cd /Users/someone && ls",
    "xdotool key Return",
    "ydotool type hi",
    "octo-click 10 10",
    "curl 127.0.0.1:9222/json/new",
  ]) {
    assert.equal(verdict(assertVmShell, c), verdict(pkg.assertVmShell, c), `assertVmShell drift on: ${c}`);
  }
  for (const path of ["/Users/someone", "/home/someone/x", "/Library/x", "/Applications/x", "/config/workspace", "", null]) {
    assert.equal(isHostPath(path), pkg.isHostPath(path), `isHostPath drift on: ${path}`);
  }
  for (const bot of [
    { vm: { container: "localbot-abc" } },
    { vm: { container: "postgres" } },
    { vm: { deskUrl: "u", deskToken: "t" } },
    { vm: {} },
    null,
  ]) {
    assert.equal(verdict(requireVm, bot), verdict(pkg.requireVm, bot), `requireVm drift on: ${JSON.stringify(bot)}`);
  }
});

console.log(fails ? `${fails} failed` : "ok isolation");
process.exit(fails ? 1 : 0);
