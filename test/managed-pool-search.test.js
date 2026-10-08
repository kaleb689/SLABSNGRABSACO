import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { searchManagedPoolProfiles } from "../managed-pool-search.js";

const profiles = [
  { id: "a", retailer: "target", loginEmail: "FIRST@example.test", status: "available", profileName: "First" },
  { id: "b", retailer: "walmart", loginEmail: "WALMART@example.test", status: "linked",
    assignedTo: { id: "customer1", name: "Test User", email: "member@example.test" }, assignmentType: "free" },
  { id: "c", retailer: "pokemoncenter", loginEmail: "pkc@example.test", status: "held" },
  { id: "d", retailer: "target", loginEmail: "broken@example.test", status: "needs_repair" }
];
test("pool search filters retailer, login, linked owner and status", () => {
  assert.deepEqual(searchManagedPoolProfiles(profiles, { retailer: "target" }).profiles.map(x => x.id).sort(), ["a", "d"]);
  assert.equal(searchManagedPoolProfiles(profiles, { query: "MEMBER@example.test" }).profiles[0].id, "b");
  assert.equal(searchManagedPoolProfiles(profiles, { query: "first@" }).profiles[0].id, "a");
  assert.equal(searchManagedPoolProfiles(profiles, { status: "held" }).profiles[0].id, "c");
  assert.equal(searchManagedPoolProfiles(profiles, { query: "absent" }).total, 0);
});
test("pool search paginates without mutating the source", () => {
  const entries = Array.from({ length: 35 }, (_, i) => ({
    id: String(i).padStart(3, "0"),
    retailer: "target",
    loginEmail: "user" + i + "@example.test",
    status: "available"
  }));
  const before = JSON.stringify(entries);
  const first = searchManagedPoolProfiles(entries, { page: 1 });
  const second = searchManagedPoolProfiles(entries, { page: 2 });
  assert.equal(first.profiles.length, 30);
  assert.equal(second.profiles.length, 5);
  assert.equal(first.total, 35);
  assert.equal(first.pageCount, 2);
  assert.equal(JSON.stringify(entries), before);
});
test("admin search is gated; linking selects exact pool record and unlink guards assignment", () => {
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const admin = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(source, /app\.get\("\/api\/admin\/managed-pool\/search", requireAdmin/);
  assert.match(source, /const managedAccountId = clean\(req\.body\?\.managedAccountId, 150\)/);
  assert.match(source, /const exactAccount = available\.find/);
  assert.match(source, /const expectedAssignmentId = clean\(req\.body\?\.expectedAssignmentId, 150\)/);
  assert.match(admin, /id="adminPoolBrowser"/);
  assert.match(admin, /admin-pool-search\.js/);
});
