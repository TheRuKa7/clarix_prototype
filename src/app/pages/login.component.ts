import { Component, ChangeDetectionStrategy, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { AuthService } from '../core/auth/services/auth.service';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-login',
  imports: [CommonModule, LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  private readonly authService = inject(AuthService);
  public isLoading = signal(false);

  /** Demo build: no Microsoft app, the button opens the demo workspace. */
  protected readonly demo = environment.demo;

  async handleMicrosoftLogin(): Promise<void> {
    this.isLoading.set(true);
    await this.authService.login();
    this.isLoading.set(false);
  }
}
