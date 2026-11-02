import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { WorkflowsShellComponent } from './components/workflows-shell/workflows-shell.component';

@Component({
  selector: 'app-workflows-layout',
  standalone: true,
  imports: [CommonModule, RouterModule, LucideAngularModule, WorkflowsShellComponent],
  templateUrl: './workflows-layout.component.html',
  styleUrl: './workflows-layout.component.scss',
})
export class WorkflowsLayoutComponent {}
