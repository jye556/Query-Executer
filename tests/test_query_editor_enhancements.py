import os
import tempfile
import unittest

from app.db_service import execute_query, validate_query


class QueryEditorEnhancementTests(unittest.TestCase):
    def test_all_sql_statement_categories_are_allowed_for_all_roles(self):
        statements = (
            "CREATE TABLE demo (id INTEGER)",
            "ALTER TABLE demo ADD COLUMN name TEXT",
            "DROP TABLE demo",
            "TRUNCATE TABLE demo",
            "GRANT SELECT ON demo TO analyst",
            "REVOKE SELECT ON demo FROM analyst",
            "VACUUM",
            "PRAGMA table_info(demo)",
            "ATTACH DATABASE 'other.db' AS other",
            "DETACH DATABASE other",
            "COPY demo FROM STDIN",
            "CALL refresh_demo()",
            "EXEC refresh_demo",
            "MERGE INTO demo USING source ON demo.id = source.id WHEN MATCHED THEN UPDATE SET name = source.name",
            "EXPLAIN SELECT * FROM demo",
            "SHOW TABLES",
            "SET search_path TO public",
            "BEGIN",
            "COMMIT",
            "ROLLBACK",
        )
        for role in ("viewer", "writer", "admin", "legacy-role"):
            for statement in statements:
                with self.subTest(role=role, statement=statement):
                    ok, error, normalized, _ = validate_query(statement, role)
                    self.assertTrue(ok, error)
                    self.assertEqual(normalized, statement)

    def test_multiple_statements_remain_a_single_request_boundary(self):
        ok, error, _, _ = validate_query("CREATE TABLE demo (id INTEGER); DROP TABLE demo")
        self.assertFalse(ok)
        self.assertEqual(error, "Multiple SQL statements are not allowed")

    def test_sqlite_executes_schema_and_metadata_commands(self):
        fd, database = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            for query in (
                "CREATE TABLE demo (id INTEGER)",
                "INSERT INTO demo (id) VALUES (1)",
                "ALTER TABLE demo ADD COLUMN name TEXT",
                "UPDATE demo SET name = 'one' WHERE id = 1",
            ):
                result = execute_query(query, db_type="sqlite", database=database, role="viewer")
                self.assertTrue(result["success"], result)

            metadata = execute_query("PRAGMA table_info(demo)", db_type="sqlite", database=database)
            self.assertTrue(metadata["success"], metadata)
            self.assertIn("name", [row["name"] for row in metadata["data"]])

            returned = execute_query("INSERT INTO demo (id, name) VALUES (2, 'two') RETURNING id, name", db_type="sqlite", database=database)
            self.assertTrue(returned["success"], returned)
            self.assertEqual(returned["data"], [{"id": 2, "name": "two"}])

            dropped = execute_query("DROP TABLE demo", db_type="sqlite", database=database)
            self.assertTrue(dropped["success"], dropped)
        finally:
            os.unlink(database)


if __name__ == "__main__":
    unittest.main()
