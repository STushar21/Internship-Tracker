import os
import smtplib
import ssl
from datetime import date, timedelta
from email.mime.text import MIMEText

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
GMAIL_ADDRESS = os.environ["GMAIL_ADDRESS"]
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]
DIGEST_RECIPIENT = os.environ["DIGEST_RECIPIENT"]

# How many days ahead counts as "closing soon"
LOOKAHEAD_DAYS = 7

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
}

today = date.today()
soon_cutoff = today + timedelta(days=LOOKAHEAD_DAYS)


def fetch_closing_soon():
    """Applications that are open (not closed) with a deadline on or before
    the lookahead cutoff — this naturally includes anything already overdue
    too, since there's no lower bound on the date filter."""
    query = (
        f"{SUPABASE_URL}/rest/v1/applications"
        f"?select=company,role,deadline"
        f"&closed=is.null"
        f"&deadline=not.is.null"
        f"&deadline=lte.{soon_cutoff.isoformat()}"
        f"&order=deadline.asc"
    )
    response = requests.get(query, headers=HEADERS)
    response.raise_for_status()
    return response.json()


def fetch_followups_due():
    """Contacts that are open (not closed) with a next-follow-up date on or
    before today — due today or overdue."""
    query = (
        f"{SUPABASE_URL}/rest/v1/contacts"
        f"?select=name,firm,next_follow_up"
        f"&closed=is.null"
        f"&next_follow_up=not.is.null"
        f"&next_follow_up=lte.{today.isoformat()}"
        f"&order=next_follow_up.asc"
    )
    response = requests.get(query, headers=HEADERS)
    response.raise_for_status()
    return response.json()


def format_deadline_line(app):
    deadline = date.fromisoformat(app["deadline"])
    days = (deadline - today).days
    if days < 0:
        status = f"OVERDUE by {abs(days)}d"
    elif days == 0:
        status = "today"
    else:
        status = f"{days}d left"
    return f"  - {app['company']} — {app['role']} (closes {app['deadline']}, {status})"


def format_followup_line(contact):
    due = date.fromisoformat(contact["next_follow_up"])
    days = (today - due).days
    status = "today" if days == 0 else f"{days}d overdue"
    return f"  - {contact['name']} ({contact['firm']}) — due {contact['next_follow_up']}, {status}"


def send_email(subject, body):
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = DIGEST_RECIPIENT

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
        server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        server.sendmail(GMAIL_ADDRESS, DIGEST_RECIPIENT, msg.as_string())


def main():
    closing_soon = fetch_closing_soon()
    followups_due = fetch_followups_due()

    # Nothing to report — skip sending so the inbox doesn't fill with empty digests
    if not closing_soon and not followups_due:
        print("Nothing due — skipping email.")
        return

    lines = []
    if closing_soon:
        lines.append(f"CLOSING SOON (within {LOOKAHEAD_DAYS} days, or overdue)")
        lines.extend(format_deadline_line(a) for a in closing_soon)
        lines.append("")
    if followups_due:
        lines.append("FOLLOW-UPS DUE")
        lines.extend(format_followup_line(c) for c in followups_due)

    body = "\n".join(lines)
    subject = f"STK Digest — {len(closing_soon)} closing soon, {len(followups_due)} follow-ups due"

    send_email(subject, body)
    print("Digest sent:", subject)


if __name__ == "__main__":
    main()
