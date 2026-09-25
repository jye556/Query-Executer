const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CURRENT_VERSION = "1.0.6";

const root = path.join(__dirname, "..");
const template = fs.readFileSync(path.join(root, "app/templates/index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "app/static/js/app.js"), "utf8");
const releases = JSON.parse(fs.readFileSync(path.join(root, "app/releases.json"), "utf8"));

const pageOne = template.match(/<section[^>]*id="totp-step-one"[^>]*>([\s\S]*?)<\/section>/)?.[1];
const pageTwo = template.match(/<section[^>]*id="totp-step-two"[^>]*>([\s\S]*?)<\/section>/)?.[1];
assert.ok(pageOne, "2FA setup page one exists");
assert.ok(pageTwo, "2FA setup page two exists");
assert.match(pageOne, /id="totp-setup-qr"/);
assert.match(pageOne, /id="totp-setup-secret"/);
assert.doesNotMatch(pageOne, /totp-step-two-code/);
assert.match(pageTwo, /id="totp-step-two-code"/);
assert.match(pageTwo, /inputmode="numeric"/);
assert.match(pageTwo, /id="btn-confirm-totp-setup"/);
assert.match(script, /if \(step === "1"\) \{\s*event\.preventDefault\(\);/);
assert.match(script, /totpStepTwo\?\.querySelectorAll\("input, button"\)\.forEach\(element => \{ element\.disabled = false; \}\)/);
assert.match(script, /body: JSON\.stringify\(\{ code: verifyTotp\.value\.trim\(\) \}\)/);
assert.doesNotMatch(template, /id="totp-setup-code"/);

const heading = template.match(/<div class="logo-text">([\s\S]*?)<\/div>/)?.[1];
assert.ok(heading, "brand heading exists");
assert.match(heading, /<h1>Query Execute<\/h1>[\s\S]*<span[^>]*id="app-version-pill"/);
assert.match(template, /id="version-update-link"[^>]*>View update<\/a>/);
assert.match(template, /<header class="app-header">[\s\S]*id="version-update-link"/);
assert.match(script, /pageLink\.href = update\.release_url/);
assert.match(script, /fetch\("\/api\/version", \{ credentials: "same-origin" \}\)/);
assert.match(script, /pageMessage\.textContent = message/);
assert.equal(releases.version, CURRENT_VERSION);
assert.equal(releases.releases[0].version, releases.version);
assert.match(template, new RegExp(`id="app-version-pill">v${CURRENT_VERSION}<`));
assert.match(template, new RegExp(`id="current-app-version">v${CURRENT_VERSION}<`));
assert.equal(new Set(releases.releases.map(release => release.version)).size, releases.releases.length);

(async () => {
    const statements = [];
    const elements = new Map();
    const mk = id => ({
        id, textContent: "", href: "#", dataset: {},
        classList: { toggle(name, hidden) { statements.push([id, "toggle", name, hidden]); }, add() {} },
    });
    for (const id of ["update-status", "version-update-banner", "version-update-message", "version-update-link", "app-version-pill", "current-app-version", "btn-apply-update", "release-log"]) {
        elements.set(id, mk(id));
    }
    const context = {
        document: { getElementById: id => elements.get(id) || null, addEventListener() {} },
        window: { addEventListener() {} },
        escapeHtml: value => value,
        fetch: async url => ({
            ok: true,
            async json() { return { version: "1.0.6", latest_version: "1.0.7", update_available: true, release_url: "https://example.test/release/v1.0.7", changelog: [] }; },
        }),
    };
    const updateStart = script.indexOf("async function fetchVersionData()");
    const updateEnd = script.indexOf("\nfunction applyTheme(", updateStart);
    assert.notEqual(updateStart, -1);
    assert.notEqual(updateEnd, -1);
    await require("node:vm").runInNewContext(`${script.slice(updateStart, updateEnd)}\ncheckForUpdates()`, context);
    assert.equal(elements.get("app-version-pill").textContent, `v${CURRENT_VERSION}`);
    assert.equal(elements.get("version-update-message").textContent, "Version v1.0.7 is available.");
    assert.equal(elements.get("version-update-link").href, "https://example.test/release/v1.0.7");
    assert.ok(statements.some(([, action, , hidden]) => action === "toggle" && hidden === false));
    console.log("2FA pages, header update/version display, and availability flow verified");
})().catch(error => { console.error(error); process.exitCode = 1; });
