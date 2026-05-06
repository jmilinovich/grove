/**
 * Waitlist capture for the hosted grove.md product.
 *
 * Public POST /waitlist accepts {email, source}, persists to the
 * `waitlist` table (one row per email — duplicates are no-ops so a user
 * who clicks twice doesn't trigger two notification emails), and fires a
 * notification email to GROVE_WAITLIST_NOTIFY_EMAIL via the existing
 * Resend wiring in email.ts.
 *
 * Admin GET /admin/waitlist returns the rows for John's eyes — the same
 * data is in `sqlite3 grove.db` but the endpoint avoids an SSH round-trip
 * when reviewing signups from the grove-www admin panel.
 */

import { getDb } from "./db.js";
import { sendWaitlistNotificationEmail } from "./email.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface WaitlistEntry {
  id: number;
  email: string;
  source: string;
  ip: string | null;
  user_agent: string | null;
  notes: string | null;
  created_at: string;
}

export interface AddToWaitlistInput {
  email: string;
  source?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AddToWaitlistResult {
  ok: true;
  /** True when this is a fresh signup; false when the email already existed. */
  added: boolean;
  email: string;
}

/** Validate + normalise an email address. Returns the lowercased trimmed
 *  form, or null if it doesn't pass the basic shape check. */
export function normaliseEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

/**
 * Insert a waitlist row. Idempotent — a duplicate email returns
 * `{ added: false }` instead of erroring, so the public endpoint can
 * safely return 200 either way without leaking whether this was a
 * resignup. The notification email is only sent on a fresh insert.
 */
export async function addToWaitlist(input: AddToWaitlistInput): Promise<AddToWaitlistResult> {
  const email = normaliseEmail(input.email);
  if (!email) {
    throw new InvalidWaitlistEmailError();
  }
  const source = (input.source ?? "unknown").slice(0, 64);
  const ip = input.ip ?? null;
  const userAgent = input.userAgent ?? null;

  const db = getDb();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO waitlist (email, source, ip, user_agent)
       VALUES (?, ?, ?, ?)`,
    )
    .run(email, source, ip, userAgent);

  const added = result.changes > 0;

  if (added) {
    // Fire the notification email. We don't await deliverability — Resend
    // is fast but we don't want a flaky third-party to turn a successful
    // DB write into a 500 to the user.
    void sendWaitlistNotificationEmail({ email, source, ip, userAgent }).catch((err) => {
      console.error("[waitlist] notification email failed:", err);
    });
  }

  return { ok: true, added, email };
}

/** List signups, newest first. `limit` defaults to 500; cap is 5000. */
export function listWaitlist(limit = 500): WaitlistEntry[] {
  const cap = Math.min(Math.max(1, limit | 0), 5000);
  const db = getDb();
  return db
    .prepare(
      `SELECT id, email, source, ip, user_agent, notes, created_at
         FROM waitlist
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(cap) as WaitlistEntry[];
}

/** Total signup count — cheap COUNT(*) for the admin panel header. */
export function waitlistCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS n FROM waitlist").get() as { n: number };
  return row.n;
}

export class InvalidWaitlistEmailError extends Error {
  constructor() {
    super("invalid email");
    this.name = "InvalidWaitlistEmailError";
  }
}
