import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";

import { buildOrganizationSearch } from "../lib/organization-search.js";

test("organization search uses a valid SQLite escape character and treats wildcards literally", async () => {
  const client = createClient({ url: "file::memory:" });
  await client.execute("CREATE TABLE organizations (name TEXT, description TEXT, summary TEXT, context TEXT)");
  await client.execute({
    sql: "INSERT INTO organizations (name, description, summary, context) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    args: ["100% Research", "literal percent", "", "", "1000 Research", "", "", ""],
  });

  const { whereClause, values } = buildOrganizationSearch("100%");
  const result = await client.execute({
    sql: `SELECT name FROM organizations ${whereClause} ORDER BY name`,
    args: values,
  });

  assert.deepEqual(result.rows.map((row) => row.name), ["100% Research"]);
});
