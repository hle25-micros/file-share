import { Component, inject, Input, OnChanges, OnInit, signal, SimpleChanges, PLATFORM_ID } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FileService, FileInfo } from '../../services/file.service';

@Component({
  selector: 'app-file-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './file-list.component.html',
  styleUrl: './file-list.component.scss',
})
export class FileListComponent implements OnInit, OnChanges {
  @Input() refreshTrigger = 0;

  private fileService = inject(FileService);
  private platformId = inject(PLATFORM_ID);

  files = signal<FileInfo[]>([]);
  isLoading = signal<boolean>(false);
  deleteConfirm = signal<string | null>(null);

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.loadFiles();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['refreshTrigger'] && !changes['refreshTrigger'].firstChange) {
      this.loadFiles();
    }
  }

  loadFiles(): void {
    this.isLoading.set(true);
    this.fileService.getFiles().subscribe({
      next: files => {
        this.files.set(files);
        this.isLoading.set(false);
      },
      error: () => {
        this.isLoading.set(false);
      },
    });
  }

  downloadFile(file: FileInfo): void {
    const url = this.fileService.getDownloadUrl(file.id);
    if (isPlatformBrowser(this.platformId)) {
      const a = document.createElement('a');
      a.href = url;
      a.download = file.originalName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  confirmDelete(fileId: string): void {
    this.deleteConfirm.set(fileId);
  }

  cancelDelete(): void {
    this.deleteConfirm.set(null);
  }

  deleteFile(fileId: string): void {
    this.fileService.deleteFile(fileId).subscribe({
      next: () => {
        this.files.update(files => files.filter(f => f.id !== fileId));
        this.deleteConfirm.set(null);
      },
      error: () => {
        this.deleteConfirm.set(null);
      },
    });
  }

  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  getFileIcon(mimeType: string): string {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📄';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z') || mimeType.includes('tar') || mimeType.includes('compressed')) return '📦';
    if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
    if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📎';
    return '📄';
  }
}
