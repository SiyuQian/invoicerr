import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./run-specs.sh", import.meta.url));

// Only the external Cypress process is simulated: its documented default cleanup stays real.
function fakeCypress() {
  const fs = require("node:fs");
  const path = require("node:path");
  const args = process.argv.slice(2);
  const spec = args[args.indexOf("--spec") + 1];
  const name = path.basename(spec);
  const config = {
    screenshotsFolder: process.env.CYPRESS_screenshotsFolder || "cypress/screenshots",
    videosFolder: process.env.CYPRESS_videosFolder || "cypress/videos",
    downloadsFolder: "cypress/downloads",
    trashAssetsBeforeRuns: process.env.CYPRESS_trashAssetsBeforeRuns || "true",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") Object.assign(config, Object.fromEntries(args[++i].split(",").map((entry) => entry.split("="))));
  }
  if (config.trashAssetsBeforeRuns !== "false") {
    for (const key of ["screenshotsFolder", "videosFolder", "downloadsFolder"]) fs.rmSync(config[key], { recursive: true, force: true });
  }
  for (const key of ["screenshotsFolder", "videosFolder", "downloadsFolder"]) fs.mkdirSync(config[key], { recursive: true });
  const calls = fs.existsSync("calls.json") ? JSON.parse(fs.readFileSync("calls.json", "utf8")) : [];
  const attempt = calls.filter((call) => call.spec === spec).length + 1;
  calls.push({ spec, args, downloads: fs.readdirSync(config.downloadsFolder) });
  fs.writeFileSync("calls.json", JSON.stringify(calls));
  fs.writeFileSync(path.join(config.downloadsFolder, name + ".pdf"), name);
  fs.writeFileSync(path.join(config.videosFolder, name + ".mp4"), name);
  if (name === "01-fail.cy.ts") fs.writeFileSync(path.join(config.screenshotsFolder, "failure.png"), name);
  const noTests = name !== "01-fail.cy.ts";
  if (name !== "02-pass.cy.ts") console.log("The browser never connected");
  console.log("Tests: " + (noTests ? 0 : 1));
  if (name === "03-retry.cy.ts" && attempt === 1) process.exit(1);
  process.exit({ "01-fail.cy.ts": 1, "04-timeout.cy.ts": 124, "05-killed.cy.ts": 137 }[name] || 0);
}

function run(t, specs, limit = "15") {
  const cwd = mkdtempSync(join(tmpdir(), "run-specs-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const cypress = join(bin, "cypress.cjs");
  writeFileSync(cypress, `(${fakeCypress.toString()})();`);
  // macOS has no GNU timeout: validate its arguments, then execute the bounded fake directly.
  writeFileSync(join(bin, "timeout"), '#!/usr/bin/env bash\n[[ "$1" == "--kill-after=30" && "$2" == "${SPEC_TIMEOUT_MIN:-15}m" ]] || exit 99\nshift 2\nexec "$@"\n', { mode: 0o755 });
  const result = spawnSync("bash", [runner, specs.join(","), "--browser", "firefox", "--env", "note=two words", "--config", "defaultCommandTimeout=4000"], {
    cwd,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CYPRESS_BIN: `${process.execPath} ${cypress}`, SPEC_TIMEOUT_MIN: limit },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  return { cwd, result, calls: JSON.parse(readFileSync(join(cwd, "calls.json"), "utf8")) };
}

test("keeps earlier failed-spec diagnostics while clearing downloads before the next spec", (t) => {
  const specs = ["cypress/e2e/01-fail.cy.ts", "cypress/e2e/02-pass.cy.ts"];
  const { cwd, result, calls } = run(t, specs);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(calls.map((call) => call.spec), specs, "a failed test must not retry or stop later specs");
  for (const call of calls) {
    assert.deepEqual(call.downloads, [], "downloads from a previous spec must be cleared");
    assert.deepEqual(call.args, ["run", "--browser", "firefox", "--env", "note=two words", "--config", "defaultCommandTimeout=4000", "--spec", call.spec]);
  }
  const contents = (root) => readdirSync(join(cwd, root), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")).sort();
  assert.deepEqual(contents("cypress/screenshots"), ["01-fail.cy.ts"], "the later run must retain the first failure image");
  assert.deepEqual(contents("cypress/videos"), ["01-fail.cy.ts", "02-pass.cy.ts"], "both runs must retain their video");
  assert.deepEqual(readdirSync(join(cwd, "cypress/downloads")), ["02-pass.cy.ts.pdf"]);
});

test("retries a browser connection failure only before any test ran", (t) => {
  const spec = "cypress/e2e/scenarios/03-retry.cy.ts";
  const { result, calls } = run(t, [spec], "25");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(calls.map((call) => call.spec), [spec, spec]);
});

for (const name of ["04-timeout.cy.ts", "05-killed.cy.ts"]) {
  test(`reports ${name} as failed without retrying`, (t) => {
    const { result, calls } = run(t, [`cypress/e2e/${name}`]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(calls.length, 1);
    assert.match(result.stderr, /exceeded 15 minutes and was killed/);
  });
}
