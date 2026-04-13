import { Component, ChangeDetectorRef, EventEmitter, inject, OnInit, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FileService, UploadConfig, UploadProgress } from '../../services/file.service';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './upload.component.html',
  styleUrl: './upload.component.scss',
})
export class UploadComponent implements OnInit {
  @Output() fileUploaded = new EventEmitter<void>();

  private fileService = inject(FileService);
  private cdr = inject(ChangeDetectorRef);

  uploadConfig = signal<UploadConfig | null>(null);
  selectedFile = signal<File | null>(null);
  uploadProgress = signal<number>(0);
  isUploading = signal<boolean>(false);
  isDragOver = signal<boolean>(false);
  message = signal<{ type: 'success' | 'error'; text: string } | null>(null);

  ngOnInit(): void {
    this.fileService.getUploadConfig().subscribe({
      next: config => this.uploadConfig.set(config),
      error: () => this.uploadConfig.set({ maxFileSizeMB: 100, allowedExtensions: [] }),
    });
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.selectFile(files[0]);
    }
  }

  onFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.selectFile(input.files[0]);
    }
    // Reset input so the same file can be selected again
    input.value = '';
  }

  private selectFile(file: File): void {
    this.message.set(null);
    const config = this.uploadConfig();

    // Validate file size
    if (config && file.size > config.maxFileSizeMB * 1024 * 1024) {
      this.message.set({
        type: 'error',
        text: `File too large. Maximum size is ${config.maxFileSizeMB}MB.`,
      });
      return;
    }

    // Validate extension
    if (config && config.allowedExtensions.length > 0) {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!config.allowedExtensions.includes(ext)) {
        this.message.set({
          type: 'error',
          text: `File type "${ext}" is not allowed.`,
        });
        return;
      }
    }

    this.selectedFile.set(file);
  }

  removeSelectedFile(): void {
    this.selectedFile.set(null);
    this.message.set(null);
  }

  upload(): void {
    const file = this.selectedFile();
    if (!file) return;

    this.isUploading.set(true);
    this.uploadProgress.set(0);
    this.message.set(null);

    this.fileService.uploadFile(file).subscribe({
      next: (event: UploadProgress) => {
        if (event.status === 'progress') {
          this.uploadProgress.set(event.progress);
          this.cdr.detectChanges();
        } else if (event.status === 'done') {
          this.isUploading.set(false);
          this.uploadProgress.set(100);
          this.selectedFile.set(null);
          this.message.set({
            type: 'success',
            text: `"${event.file?.originalName}" uploaded successfully!`,
          });
          this.fileUploaded.emit();
          this.cdr.detectChanges();
          // Clear success message after 5 seconds
          setTimeout(() => {
            if (this.message()?.type === 'success') {
              this.message.set(null);
              this.cdr.detectChanges();
            }
          }, 5000);
        } else if (event.status === 'error') {
          this.isUploading.set(false);
          this.uploadProgress.set(0);
          this.message.set({
            type: 'error',
            text: event.error || 'Upload failed. Please try again.',
          });
          this.cdr.detectChanges();
        }
      },
      error: (err) => {
        this.isUploading.set(false);
        this.uploadProgress.set(0);
        this.message.set({
          type: 'error',
          text: err.error?.error || 'Upload failed. Please try again.',
        });
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
}
