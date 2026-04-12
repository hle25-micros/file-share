import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { UploadComponent } from '../../components/upload/upload.component';
import { FileListComponent } from '../../components/file-list/file-list.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, UploadComponent, FileListComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);

  refreshTrigger = signal<number>(0);

  ngOnInit(): void {}

  onFileUploaded(): void {
    this.refreshTrigger.update(v => v + 1);
  }

  logout(): void {
    this.authService.logout().subscribe(() => {
      this.router.navigate(['/login']);
    });
  }
}
