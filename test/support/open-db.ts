// Child process: opens (and so migrates) the database at the given path, then prints the applied migration ids.
//   node --import tsx test/support/open-db.ts <dbPath>
import { openDatabase } from "../../src/db/sqlite.ts";

const db = openDatabase(process.argv[2]!);
const ids = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
db.close();
console.log(ids.join(","));
