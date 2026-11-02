import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { TransformationCatalogEntry } from '../../models/transformation-catalog.model';
import { TransformationCatalogService } from '../../services/transformation-catalog.service';

/** Build > Data > Transformations — a read-only catalog of what happens to an upload's rows. */
@Component({
  selector: 'app-transformations',
  imports: [CommonModule],
  templateUrl: './transformations.component.html',
  styleUrl: './transformations.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransformationsComponent implements OnInit {
  private readonly catalogService = inject(TransformationCatalogService);

  protected readonly loading = signal(false);
  protected readonly entries = signal<TransformationCatalogEntry[]>([]);

  ngOnInit(): void {
    this.loading.set(true);
    this.catalogService.list().subscribe({
      next: (entries) => {
        this.entries.set(entries);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
