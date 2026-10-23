"""Spin up a throw-away database for UI testing.

Builds a fresh SQLite file, migrates it, loads the starter categories/accounts, seeds a demo
paycheck and a future-dated transaction, then serves the app against it.

    python scripts/scratch_ui.py [--db data/scratch.db] [--port 8000] [--no-seed] [--reload]

The real ``data/budget.db`` is never touched: a guard refuses to delete it. Re-running resets the
scratch file, so you always start from a clean slate.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

STARTER_CONFIG = ROOT / "samples" / "starter-config.json"


def _reset_database(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    for stale in db_path.parent.glob(db_path.name + "*"):  # sqlite sidecars: -wal, -shm, -journal
        stale.unlink(missing_ok=True)


def _migrate() -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    command.upgrade(cfg, "head")


def _seed(session) -> None:
    from sqlalchemy import select

    from app.models import Account, Category, RecurringTemplate, Transaction

    def category(name: str) -> Category:
        cat = session.scalar(select(Category).where(Category.name == name))
        if cat is None:
            raise SystemExit(f"Starter config has no category named {name!r}")
        return cat

    def account(name: str) -> Account:
        acc = session.scalar(select(Account).where(Account.name == name))
        if acc is None:
            raise SystemExit(f"Starter config has no account named {name!r}")
        return acc

    session.add(
        RecurringTemplate(
            description="Paycheque",
            category_id=category("Salary (net)").id,
            account_id=account("Chequing").id,
            amount_cents=200000,
            day_of_month=1,
            schedule=None,
            is_active=True,
        )
    )
    session.add(
        Transaction(
            date=date.today() + timedelta(days=1),
            description="Upcoming bill",
            category_id=category("Dining Out / Takeout").id,
            account_id=account("Chequing").id,
            amount_cents=2500,
            notes=None,
        )
    )
    session.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default="data/scratch.db", help="Scratch database path (default: data/scratch.db)")
    parser.add_argument("--port", type=int, default=8000, help="API port (default: 8000)")
    parser.add_argument("--no-seed", action="store_true", help="Skip the demo paycheck + future transaction")
    parser.add_argument("--reload", action="store_true", help="Enable uvicorn auto-reload")
    args = parser.parse_args()

    db_path = (ROOT / args.db).resolve()
    if db_path.name == "budget.db":
        raise SystemExit("Refusing to touch the real data/budget.db; pick another --db name.")

    os.environ["DATABASE_URL"] = f"sqlite:///{db_path.as_posix()}"

    _reset_database(db_path)
    _migrate()

    from app.db.session import get_sessionmaker
    from app.services.config_io import import_config

    with get_sessionmaker()() as session:
        import_config(session, json.loads(STARTER_CONFIG.read_text(encoding="utf-8")), replace=True)
        if not args.no_seed:
            _seed(session)

    print(f"\nScratch database ready: {db_path}")
    print(f"Backend:    http://127.0.0.1:{args.port}")
    print("Frontend:   in another terminal run  cd frontend && npm run dev  (then open the vite URL)")
    print("Try it:     Plans -> Add plan -> Rolling -> account 'Chequing'; look at 'safe to spend' and Events.\n")

    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
