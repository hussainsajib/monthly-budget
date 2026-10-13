"""Maintenance commands.

    python -m app.cli import-xlsx <workbook.xlsx>          load transactions from the old workbook
    python -m app.cli clear-transactions [--imported-only] [--yes]  delete transaction rows (keeps setup)
    python -m app.cli export-config <file.json>            save categories/accounts/recurring/budgets/settings
    python -m app.cli import-config <file.json> [--replace]  load them into this database
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from sqlalchemy import delete, func, select

from app.db.session import get_sessionmaker
from app.models import Transaction
from app.services.config_io import ConfigError, export_config, import_config
from app.services.xlsx_import import import_workbook


def main() -> None:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    imp = sub.add_parser("import-xlsx", help="Import the Transactions sheet from the old workbook")
    imp.add_argument("path", type=Path)

    clr = sub.add_parser("clear-transactions", help="Delete transaction rows (setup is kept)")
    clr.add_argument("--imported-only", action="store_true", help="Keep hand-entered rows; delete imported only")
    clr.add_argument("--yes", action="store_true", help="Skip the confirmation prompt")

    exp = sub.add_parser("export-config", help="Write your setup (not transactions) to a JSON file")
    exp.add_argument("path", type=Path)

    cfg = sub.add_parser("import-config", help="Load a setup file written by export-config")
    cfg.add_argument("path", type=Path)
    cfg.add_argument(
        "--replace",
        action="store_true",
        help="Wipe the existing categories/accounts/recurring items first (refused if transactions exist)",
    )
    args = parser.parse_args()

    if args.command == "import-xlsx":
        with get_sessionmaker()() as db:
            created, skipped = import_workbook(db, args.path)
        print(f"Imported {created} transactions ({skipped} already present).")

    elif args.command == "clear-transactions":
        with get_sessionmaker()() as db:
            count_stmt = select(func.count()).select_from(Transaction)
            delete_stmt = delete(Transaction)
            if args.imported_only:
                count_stmt = count_stmt.where(Transaction.import_hash.is_not(None))
                delete_stmt = delete_stmt.where(Transaction.import_hash.is_not(None))
            count = db.scalar(count_stmt) or 0
            label = "imported transactions" if args.imported_only else "transactions"
            if count == 0:
                print(f"No {label} to delete.")
                return
            if not args.yes:
                answer = input(f"Delete {count} {label}? This cannot be undone. Type 'yes' to continue: ")
                if answer.strip().lower() != "yes":
                    print("Cancelled.")
                    return
            db.execute(delete_stmt)
            db.commit()
        print(f"Deleted {count} {label}.")

    elif args.command == "export-config":
        with get_sessionmaker()() as db:
            data = export_config(db)
        args.path.parent.mkdir(parents=True, exist_ok=True)
        args.path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(
            f"Wrote {args.path}: {len(data['categories'])} categories, {len(data['accounts'])} accounts, "
            f"{len(data['recurring'])} recurring items, {len(data['monthly_budgets'])} monthly budgets."
        )

    elif args.command == "import-config":
        try:
            data = json.loads(args.path.read_text(encoding="utf-8"))
            with get_sessionmaker()() as db:
                counts = import_config(db, data, replace=args.replace)
        except (ConfigError, OSError, json.JSONDecodeError) as exc:
            sys.exit(f"error: {exc}")
        print("Imported " + ", ".join(f"{n} {name.replace('_', ' ')}" for name, n in counts.items()) + ".")


if __name__ == "__main__":
    main()
