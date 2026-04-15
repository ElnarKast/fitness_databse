#!/usr/bin/env python3
"""
bank_bridge.py
==============
Bridges the Fitness Club (MySQL) database with the Banking (PostgreSQL) database.

What it does
------------
1. Reads **active memberships** from the fitness DB.
2. For each membership whose monthly fee has not yet been paid this month,
   executes a payment from the member's bank account to the club's bank account.
3. Reads **trainers** from the fitness DB.
4. For each trainer, pays a monthly salary from the club's bank account to
   the trainer's bank account (if not already paid this month).
5. All payments go through the PostgreSQL stored procedure ``make_payment``,
   which validates the transfer, updates balances, and logs errors automatically.

Usage
-----
    python bank_bridge.py

Environment variables (can also live in a .env file):
    MySQL fitness database:
        FITNESS_DB_HOST     (default: localhost)
        FITNESS_DB_PORT     (default: 3306)
        FITNESS_DB_USER     (default: root)
        FITNESS_DB_PASSWORD (default: "")
        FITNESS_DB_NAME     (default: fitness_club_db)

    PostgreSQL banking database:
        BANK_DB_HOST        (default: localhost)
        BANK_DB_PORT        (default: 5432)
        BANK_DB_USER        (default: postgres)
        BANK_DB_PASSWORD    (default: "")
        BANK_DB_NAME        (default: bank_db)

Dependencies
------------
    pip install mysql-connector-python psycopg2-binary python-dotenv
"""

import os
import sys
import logging
from datetime import date, datetime
from decimal import Decimal

import mysql.connector
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("bank_bridge")

# Monthly salary amounts per trainer (could also be stored in the fitness DB)
TRAINER_MONTHLY_SALARY = Decimal("3000.00")


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_fitness_connection():
    """Return an open MySQL connection to the fitness database."""
    return mysql.connector.connect(
        host=os.getenv("FITNESS_DB_HOST", "localhost"),
        port=int(os.getenv("FITNESS_DB_PORT", 3306)),
        user=os.getenv("FITNESS_DB_USER", "root"),
        password=os.getenv("FITNESS_DB_PASSWORD", ""),
        database=os.getenv("FITNESS_DB_NAME", "fitness_club_db"),
    )


def get_bank_connection():
    """Return an open psycopg2 connection to the banking database."""
    return psycopg2.connect(
        host=os.getenv("BANK_DB_HOST", "localhost"),
        port=int(os.getenv("BANK_DB_PORT", 5432)),
        user=os.getenv("BANK_DB_USER", "postgres"),
        password=os.getenv("BANK_DB_PASSWORD", ""),
        dbname=os.getenv("BANK_DB_NAME", "bank_db"),
    )


# ---------------------------------------------------------------------------
# Fitness DB queries
# ---------------------------------------------------------------------------

def fetch_active_memberships(fitness_conn):
    """Return active memberships with member and club IDs."""
    cursor = fitness_conn.cursor(dictionary=True)
    cursor.execute("""
        SELECT
            m.membership_id,
            m.member_id,
            m.club_id,
            m.membership_type,
            m.price,
            mem.first_name,
            mem.last_name
        FROM memberships m
        JOIN members mem ON mem.member_id = m.member_id
        WHERE m.status = 'Active'
          AND m.price > 0
    """)
    rows = cursor.fetchall()
    cursor.close()
    return rows


def fetch_trainers(fitness_conn):
    """Return all trainers with their club assignments."""
    cursor = fitness_conn.cursor(dictionary=True)
    cursor.execute("""
        SELECT
            t.trainer_id,
            t.first_name,
            t.last_name,
            t.club_id
        FROM trainers t
        WHERE t.club_id IS NOT NULL
    """)
    rows = cursor.fetchall()
    cursor.close()
    return rows


# ---------------------------------------------------------------------------
# Bank DB helpers
# ---------------------------------------------------------------------------

def find_account(bank_conn, ref_type: str, ref_id: int):
    """Return the bank account_id for a given fitness entity, or None."""
    with bank_conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT account_id, balance, account_holder
            FROM   bank_accounts
            WHERE  fitness_ref_type = %s
              AND  fitness_ref_id   = %s
            """,
            (ref_type, ref_id),
        )
        return cur.fetchone()


def already_paid_this_month(bank_conn, debit_id: int, credit_id: int, reference_prefix: str) -> bool:
    """Return True if a matching transaction already exists this calendar month."""
    first_day = date.today().replace(day=1)
    with bank_conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1 FROM transactions
            WHERE  debit_account_id  = %s
              AND  credit_account_id = %s
              AND  reference LIKE %s
              AND  executed_at >= %s
            LIMIT 1
            """,
            (debit_id, credit_id, reference_prefix + "%", first_day),
        )
        return cur.fetchone() is not None


def execute_payment(bank_conn, debit_id: int, credit_id: int,
                    amount: Decimal, description: str, reference: str) -> None:
    """Call the make_payment stored procedure."""
    with bank_conn.cursor() as cur:
        cur.execute(
            "CALL make_payment(%s, %s, %s, %s, %s)",
            (debit_id, credit_id, amount, description, reference),
        )
    bank_conn.commit()


def fetch_recent_transactions(bank_conn, limit: int = 20):
    """Return the most recent transactions for reporting."""
    with bank_conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT
                t.transaction_id,
                da.account_holder AS from_holder,
                ca.account_holder AS to_holder,
                t.amount,
                t.description,
                t.reference,
                t.executed_at
            FROM   transactions t
            JOIN   bank_accounts da ON da.account_id = t.debit_account_id
            JOIN   bank_accounts ca ON ca.account_id = t.credit_account_id
            ORDER  BY t.executed_at DESC
            LIMIT  %s
            """,
            (limit,),
        )
        return cur.fetchall()


def fetch_recent_errors(bank_conn, limit: int = 10):
    """Return the most recent error log entries."""
    with bank_conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT log_id, operation, error_message, details, logged_at
            FROM   error_logs
            ORDER  BY logged_at DESC
            LIMIT  %s
            """,
            (limit,),
        )
        return cur.fetchall()


# ---------------------------------------------------------------------------
# Core business logic
# ---------------------------------------------------------------------------

def process_membership_payments(fitness_conn, bank_conn) -> dict:
    """
    Pay monthly membership fee for each active membership.
    Returns a summary dict.
    """
    memberships = fetch_active_memberships(fitness_conn)
    log.info("Active memberships fetched: %d", len(memberships))

    paid = 0
    skipped = 0
    failed = 0

    for ms in memberships:
        member_id   = ms["member_id"]
        club_id     = ms["club_id"]
        ms_type     = ms["membership_type"]
        ms_id       = ms["membership_id"]
        holder_name = f"{ms['first_name']} {ms['last_name']}"

        member_acct = find_account(bank_conn, "member", member_id)
        club_acct   = find_account(bank_conn, "club",   club_id)

        if not member_acct:
            log.warning("No bank account for member_id=%d (%s)", member_id, holder_name)
            failed += 1
            continue
        if not club_acct:
            log.warning("No bank account for club_id=%d", club_id)
            failed += 1
            continue

        amount    = Decimal(str(ms["price"])) / 12
        amount    = amount.quantize(Decimal("0.01"))
        reference = f"fitness:membership:{ms_id}"

        if amount <= 0:
            log.warning(
                "Membership #%d has zero or negative price — skipping", ms_id
            )
            failed += 1
            continue

        if already_paid_this_month(bank_conn, member_acct["account_id"],
                                   club_acct["account_id"], reference):
            log.debug("Membership #%d already paid this month — skipping", ms_id)
            skipped += 1
            continue

        description = (
            f"Monthly membership fee — {ms_type} — {holder_name} "
            f"({date.today().strftime('%B %Y')})"
        )
        execute_payment(
            bank_conn,
            debit_id    = member_acct["account_id"],
            credit_id   = club_acct["account_id"],
            amount      = amount,
            description = description,
            reference   = reference,
        )
        log.info(
            "Membership payment: %s → club_id=%d | %.2f | ref=%s",
            holder_name, club_id, amount, reference,
        )
        paid += 1

    return {"paid": paid, "skipped": skipped, "failed": failed}


def process_trainer_salaries(fitness_conn, bank_conn) -> dict:
    """
    Pay monthly salary to each trainer from the corresponding club account.
    Returns a summary dict.
    """
    trainers = fetch_trainers(fitness_conn)
    log.info("Trainers fetched: %d", len(trainers))

    paid = 0
    skipped = 0
    failed = 0

    for tr in trainers:
        trainer_id  = tr["trainer_id"]
        club_id     = tr["club_id"]
        trainer_name = f"{tr['first_name']} {tr['last_name']}"

        club_acct    = find_account(bank_conn, "club",    club_id)
        trainer_acct = find_account(bank_conn, "trainer", trainer_id)

        if not club_acct:
            log.warning("No bank account for club_id=%d", club_id)
            failed += 1
            continue
        if not trainer_acct:
            log.warning("No bank account for trainer_id=%d (%s)", trainer_id, trainer_name)
            failed += 1
            continue

        reference = f"fitness:salary:trainer:{trainer_id}"

        if already_paid_this_month(bank_conn, club_acct["account_id"],
                                   trainer_acct["account_id"], reference):
            log.debug("Salary for trainer_id=%d already paid this month — skipping", trainer_id)
            skipped += 1
            continue

        description = (
            f"Monthly salary — {trainer_name} "
            f"({date.today().strftime('%B %Y')})"
        )
        execute_payment(
            bank_conn,
            debit_id    = club_acct["account_id"],
            credit_id   = trainer_acct["account_id"],
            amount      = TRAINER_MONTHLY_SALARY,
            description = description,
            reference   = reference,
        )
        log.info(
            "Salary payment: club_id=%d → %s | %.2f | ref=%s",
            club_id, trainer_name, TRAINER_MONTHLY_SALARY, reference,
        )
        paid += 1

    return {"paid": paid, "skipped": skipped, "failed": failed}


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def print_report(bank_conn) -> None:
    """Print a summary of recent transactions and any errors."""
    print("\n" + "=" * 60)
    print("  RECENT TRANSACTIONS (last 20)")
    print("=" * 60)
    for tx in fetch_recent_transactions(bank_conn):
        print(
            f"  [{tx['transaction_id']:>4}] {tx['executed_at'].strftime('%Y-%m-%d %H:%M')}  "
            f"{tx['from_holder']:<22} → {tx['to_holder']:<22}  "
            f"{float(tx['amount']):>10.2f}  {tx['reference']}"
        )

    errors = fetch_recent_errors(bank_conn)
    if errors:
        print("\n" + "=" * 60)
        print("  RECENT ERRORS (last 10)")
        print("=" * 60)
        for err in errors:
            print(
                f"  [{err['log_id']:>4}] {err['logged_at'].strftime('%Y-%m-%d %H:%M')}  "
                f"{err['operation']:<20}  {err['error_message']}"
            )
    else:
        print("\n  No errors logged.")

    print("=" * 60)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    log.info("=== Fitness → Bank Bridge started ===")

    fitness_conn = None
    bank_conn    = None

    try:
        log.info("Connecting to fitness (MySQL) database …")
        fitness_conn = get_fitness_connection()
        log.info("Fitness DB connected.")

        log.info("Connecting to banking (PostgreSQL) database …")
        bank_conn = get_bank_connection()
        log.info("Bank DB connected.")

        # --- Membership payments ---
        ms_result = process_membership_payments(fitness_conn, bank_conn)
        log.info(
            "Membership payments — paid: %d, skipped: %d, failed: %d",
            ms_result["paid"], ms_result["skipped"], ms_result["failed"],
        )

        # --- Trainer salaries ---
        sal_result = process_trainer_salaries(fitness_conn, bank_conn)
        log.info(
            "Trainer salaries    — paid: %d, skipped: %d, failed: %d",
            sal_result["paid"], sal_result["skipped"], sal_result["failed"],
        )

        # --- Print report ---
        print_report(bank_conn)

        log.info("=== Bridge completed successfully ===")
        return 0

    except mysql.connector.Error as exc:
        log.error("Fitness DB error: %s", exc)
        return 1
    except psycopg2.Error as exc:
        log.error("Bank DB error: %s", exc)
        return 1
    except Exception:
        log.exception("Unexpected error")
        return 1
    finally:
        if fitness_conn:
            fitness_conn.close()
        if bank_conn:
            bank_conn.close()


if __name__ == "__main__":
    sys.exit(main())
