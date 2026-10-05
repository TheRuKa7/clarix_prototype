import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterModule } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-workflows-layout',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterOutlet, LucideAngularModule],
  templateUrl: './workflows-layout.component.html',
  styleUrl: './workflows-layout.component.scss'
})
export class WorkflowsLayoutComponent {}
