import {
  Directive,
  TemplateRef,
  ViewContainerRef,
  effect,
  inject,
  input,
} from '@angular/core';
import { PermissionsService } from '../services/permissions.service';

type PermissionMatch =
  | string
  | readonly string[]
  | { all?: readonly string[]; any?: readonly string[] };

/**
 * Structural directive: renders the host element only when the current user
 * has the required permission(s).
 *
 * Usage:
 *   <button *hasPermission="'permissions:add'">…</button>
 *   <button *hasPermission="['permissions:add', 'permissions:edit']">…</button>   // any
 *   <button *hasPermission="{ all: ['a:read', 'b:read'] }">…</button>             // all
 *   <button *hasPermission="{ any: ['a:read', 'b:read'] }">…</button>             // any
 */
@Directive({
  selector: '[hasPermission]',
})
export class HasPermissionDirective {
  private readonly tpl = inject(TemplateRef<unknown>);
  private readonly vcr = inject(ViewContainerRef);
  private readonly perms = inject(PermissionsService);

  readonly hasPermission = input.required<PermissionMatch>();

  private rendered = false;

  constructor() {
    effect(() => {
      const allowed = this.evaluate(this.hasPermission());
      if (allowed && !this.rendered) {
        this.vcr.createEmbeddedView(this.tpl);
        this.rendered = true;
      } else if (!allowed && this.rendered) {
        this.vcr.clear();
        this.rendered = false;
      }
    });
  }

  private evaluate(match: PermissionMatch): boolean {
    if (typeof match === 'string') return this.perms.has(match);
    if (Array.isArray(match)) return this.perms.hasAny(...match);
    const m = match as { all?: readonly string[]; any?: readonly string[] };
    if (m.all && m.all.length > 0 && !m.all.every(k => this.perms.has(k))) return false;
    if (m.any && m.any.length > 0 && !this.perms.hasAny(...m.any)) return false;
    return true;
  }
}
