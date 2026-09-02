'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, Input, Modal, ModalFooter, Textarea } from '@/components/ui';
import { AccountMenu } from '@/components/account-menu';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { ScheduledEmailListItem } from '@/types';

type Tab = 'scheduled' | 'sent';

function formatDate(value: string | null): string {
  if (value === null) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function Status({ status }: { status: ScheduledEmailListItem['status'] }) {
  const styles = {
    pending: 'bg-warning/15 text-warning',
    processing: 'bg-accent/15 text-accent',
    sent: 'bg-success/15 text-success',
    failed: 'bg-danger/15 text-danger',
  } as const;
  return (
    <span className={cn('rounded-full px-2 py-1 text-xs font-semibold capitalize', styles[status])}>
      {status}
    </span>
  );
}

function EmailTable({ rows, sent }: { rows: readonly ScheduledEmailListItem[]; sent: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-6 py-14 text-center text-sm text-ink-muted">
        No {sent ? 'sent' : 'scheduled'} emails yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-175 text-left text-sm">
        <thead className="bg-surface text-xs uppercase tracking-wide text-ink-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Email</th>
            <th className="px-4 py-3 font-medium">Subject</th>
            <th className="px-4 py-3 font-medium">{sent ? 'Sent time' : 'Scheduled time'}</th>
            <th className="px-4 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-line">
              <td className="px-4 py-3">{row.recipient_email}</td>
              <td className="px-4 py-3 font-medium">{row.subject}</td>
              <td className="px-4 py-3 text-ink-muted">
                {formatDate(sent ? row.sent_at : row.scheduled_at)}
              </td>
              <td className="px-4 py-3">
                <Status status={row.status} />
                {row.error === null ? null : (
                  <p className="mt-1 max-w-64 text-xs text-danger">{row.error}</p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function extractEmails(text: string): string[] {
  return [
    ...new Set(
      (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((email) =>
        email.toLowerCase(),
      ),
    ),
  ];
}

function ComposeEmail({
  onClose,
  onScheduled,
}: {
  onClose: () => void;
  onScheduled: (message: string) => void;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sender, setSender] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [leads, setLeads] = useState('');
  const [startTime, setStartTime] = useState(() =>
    new Date(Date.now() + 60_000).toISOString().slice(0, 16),
  );
  const [delaySeconds, setDelaySeconds] = useState('2');
  const [hourlyLimit, setHourlyLimit] = useState('200');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const recipients = extractEmails(leads);

  const importFile = async (file: File | undefined) => {
    if (file === undefined) return;
    setLeads(await file.text());
  };
  const submit = async () => {
    setError(null);
    if (
      sender.trim() === '' ||
      subject.trim() === '' ||
      body.trim() === '' ||
      recipients.length === 0
    ) {
      setError('Sender, subject, body, and at least one valid email address are required.');
      return;
    }
    const delay = Number(delaySeconds);
    const limit = Number(hourlyLimit);
    if (!Number.isFinite(delay) || delay < 0 || !Number.isFinite(limit) || limit < 1) {
      setError('Delay must be zero or more; hourly limit must be at least one.');
      return;
    }
    setSaving(true);
    try {
      const result = await api.schedule({
        sender: sender.trim(),
        subject: subject.trim(),
        body: body.trim(),
        recipients,
        start_time: new Date(startTime).toISOString(),
        delay_between_emails_ms: Math.round(delay * 1_000),
        hourly_limit: Math.round(limit),
      });
      onScheduled(
        `${String(result.scheduled_count)} email${result.scheduled_count === 1 ? '' : 's'} scheduled.`,
      );
      router.refresh();
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not schedule this batch.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Compose new email"
      description="Upload a CSV or paste contacts, then schedule the batch."
      size="lg"
      dismissable={!saving}
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} isLoading={saving}>
            Schedule emails
          </Button>
        </ModalFooter>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Sender email"
          placeholder="you@example.com"
          value={sender}
          onChange={(event) => setSender(event.target.value)}
          className="sm:col-span-2"
        />
        <Input
          label="Subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          className="sm:col-span-2"
        />
        <Textarea
          label="Body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="sm:col-span-2"
        />
        <div className="sm:col-span-2">
          <Textarea
            label="Leads"
            hint={`${String(recipients.length)} unique email address${recipients.length === 1 ? '' : 'es'} detected`}
            value={leads}
            onChange={(event) => setLeads(event.target.value)}
            placeholder="ada@example.com, grace@example.com"
            rows={4}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="sr-only"
            onChange={(event) => void importFile(event.target.files?.[0])}
          />
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => fileRef.current?.click()}
          >
            Upload CSV or text
          </Button>
        </div>
        <Input
          label="Start time"
          type="datetime-local"
          value={startTime}
          onChange={(event) => setStartTime(event.target.value)}
        />
        <Input
          label="Delay between emails (seconds)"
          type="number"
          min="0"
          value={delaySeconds}
          onChange={(event) => setDelaySeconds(event.target.value)}
        />
        <Input
          label="Hourly limit"
          type="number"
          min="1"
          value={hourlyLimit}
          onChange={(event) => setHourlyLimit(event.target.value)}
        />
      </div>
      {error === null ? null : (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

export function EmailDashboard({
  scheduled,
  sent,
  error,
  user,
}: {
  scheduled: readonly ScheduledEmailListItem[];
  sent: readonly ScheduledEmailListItem[];
  error: string | null;
  user: { name: string; email: string; image: string | null };
}) {
  const [tab, setTab] = useState<Tab>('scheduled');
  const [composeOpen, setComposeOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current = tab === 'scheduled' ? scheduled : sent;
  return (
    <main className="mx-auto min-h-dvh max-w-7xl px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="text-xs font-bold tracking-widest text-accent uppercase">ReachInbox</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Email scheduler</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Plan campaigns, then watch delivery in real time.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <AccountMenu user={user} />
          <Button onClick={() => setComposeOpen(true)}>Compose new email</Button>
        </div>
      </header>
      {notice === null ? null : (
        <div role="status" className="mt-5 rounded-md bg-success/15 px-4 py-3 text-sm text-success">
          {notice}
        </div>
      )}
      {error === null ? null : (
        <div role="alert" className="mt-5 rounded-md bg-danger/10 px-4 py-3 text-sm text-danger">
          The email API is unavailable: {error}
        </div>
      )}
      <section className="mt-8">
        <div className="mb-5 flex gap-1 border-b border-line">
          <button
            type="button"
            onClick={() => setTab('scheduled')}
            className={cn(
              'border-b-2 px-4 py-3 text-sm font-medium',
              tab === 'scheduled'
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-muted',
            )}
          >
            Scheduled emails{' '}
            <span className="ml-1 rounded bg-surface-muted px-1.5 py-0.5 text-xs">
              {scheduled.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setTab('sent')}
            className={cn(
              'border-b-2 px-4 py-3 text-sm font-medium',
              tab === 'sent' ? 'border-accent text-accent' : 'border-transparent text-ink-muted',
            )}
          >
            Sent emails{' '}
            <span className="ml-1 rounded bg-surface-muted px-1.5 py-0.5 text-xs">
              {sent.length}
            </span>
          </button>
        </div>
        <EmailTable rows={current} sent={tab === 'sent'} />
      </section>
      {composeOpen ? (
        <ComposeEmail onClose={() => setComposeOpen(false)} onScheduled={setNotice} />
      ) : null}
    </main>
  );
}
