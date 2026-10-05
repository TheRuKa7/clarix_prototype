import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { DataFunctionsComponent } from '../../../data-functions/pages/data-functions/data-functions.component';
import { TransformationsComponent } from '../transformations/transformations.component';

type DataTab = 'enrich' | 'transform';

/** Build > Data — lookups that fill blanks, and transformations that reshape an upload. */
@Component({
  selector: 'app-data-hub',
  imports: [CommonModule, DataFunctionsComponent, TransformationsComponent],
  templateUrl: './data-hub.component.html',
  styleUrl: './data-hub.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DataHubComponent {
  protected readonly activeTab = signal<DataTab>('enrich');

  setTab(tab: DataTab): void {
    this.activeTab.set(tab);
  }
}
