import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { FollowUp, ReportService } from '../../../dashboard/services/report.service';

/**
 * Follow ups: rows that calling alone cannot settle. The number is blocked or wrong, the contact
 * declined, or every try was used. An owner takes each one: what they said, a corrected number,
 * then back to the agent or closed. Works for any agent and any file.
 */
@Component({
  selector: 'app-follow-ups',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  templateUrl: './follow-ups.component.html',
  styleUrl: './follow-ups.component.scss',
})
export class FollowUpsComponent {
  private readonly reports = inject(ReportService);
  private readonly router = inject(Router);

  protected readonly state = signal<'open' | 'done'>('open');
  protected readonly search = signal('');
  protected readonly reason = signal('');
  protected readonly owner = signal('');
  protected readonly expanded = signal('');
  protected readonly note = signal('');
  protected readonly phone = signal('');
  protected readonly busy = signal('');
  protected readonly closing = signal<FollowUp | null>(null);
  protected readonly error = signal('');

  protected readonly list = resource({ params: () => this.state(), loader: ({ params }) => firstValueFrom(this.reports.followUps(params)) });
  protected readonly data = computed(() => this.list.value() ?? null);
  protected readonly counts = computed(() => this.data()?.counts ?? { open: 0, done: 0, by_reason: {} });
  protected readonly owners = computed(() => this.data()?.owners ?? []);
  protected readonly reasons = computed(() => Object.entries(this.data()?.reasons ?? {}).map(([key, r]) => ({ key, ...r, count: this.counts().by_reason[key] ?? 0 })).filter((r) => this.state() === 'done' || r.count));
  protected readonly filtered = computed(() => !!(this.search() || this.reason() || this.owner()));
  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase(), why = this.reason(), who = this.owner();
    return (this.data()?.rows ?? []).filter((r) => (!why || r.reason === why) && (!who || (who === '-' ? !r.owner : r.owner === who)) && (!q || [r.name, r.phone, r.campaign_name].some((v) => String(v ?? '').toLowerCase().includes(q))));
  });

  protected setState(s: 'open' | 'done'): void { this.state.set(s); this.expanded.set(''); }
  protected toggle(r: FollowUp): void { this.expanded.set(this.expanded() === r.id ? '' : r.id); this.note.set(''); this.phone.set(''); }
  protected val(ev: Event): string { return (ev.target as HTMLInputElement).value; }

  private async run(id: string, work: () => Promise<unknown>): Promise<void> {
    this.busy.set(id);
    try { await work(); this.error.set(''); this.list.reload(); } catch { this.error.set('That did not save. Try again.'); }
    this.busy.set('');
  }
  protected patch(r: FollowUp, body: Record<string, unknown>): Promise<void> { return this.run(r.id, () => firstValueFrom(this.reports.updateFollowUp(r.id, body))); }
  protected setOwner(r: FollowUp, ev: Event): void { this.patch(r, { owner: this.val(ev) }); }
  protected saveNote(r: FollowUp): void { const text = this.note().trim(); if (!text) return; this.note.set(''); this.patch(r, { note: text }); }
  protected validPhone(r: FollowUp): boolean { const d = this.phone().replace(/\D/g, ''); return d.length >= 10 && d.slice(-10) !== r.phone; }
  protected savePhone(r: FollowUp): void { const v = this.phone(); this.phone.set(''); this.patch(r, { phone: v }); }
  protected callAgain(r: FollowUp): Promise<void> { return this.run(r.id, () => firstValueFrom(this.reports.callAgain(r.id))); }
  protected closeRow(r: FollowUp): void { this.closing.set(null); this.patch(r, { state: 'done', closed_as: 'No call needed' }); }
  protected openCall(r: FollowUp): void { this.router.navigate(['/workflows/templates', r.templateId, 'executions', r.id]); }

  protected lastNote(r: FollowUp): string { return r.notes.filter((n) => !n.system).slice(-1)[0]?.text ?? ''; }
  protected telephony(r: FollowUp): string { const t = r.telephony; return t ? [t.Status, t.CustomerStatus, t.DialStatus].filter(Boolean).join(' · ') : ''; }
  protected ago(iso: string): string { const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; }
}
