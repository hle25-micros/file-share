import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { isPlatformBrowser } from '@angular/common';

export interface FileInfo {
  id: string;
  originalName: string;
  storedName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface UploadConfig {
  maxFileSizeMB: number;
  allowedExtensions: string[];
}

export interface UploadProgress {
  status: 'progress' | 'done' | 'error';
  progress: number;
  file?: FileInfo;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class FileService {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);

  getUploadConfig(): Observable<UploadConfig> {
    return this.http.get<UploadConfig>('/api/config/upload');
  }

  /**
   * Upload using raw XMLHttpRequest for real-time progress.
   * Angular HttpClient buffers progress events in zoneless mode,
   * so XHR gives much more reliable progress updates.
   */
  uploadFile(file: File): Observable<UploadProgress> {
    return new Observable<UploadProgress>(observer => {
      if (!isPlatformBrowser(this.platformId)) {
        observer.error({ error: 'Upload not supported on server' });
        return;
      }

      const formData = new FormData();
      formData.append('file', file, file.name);

      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 100);
          observer.next({ status: 'progress', progress });
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText);
            if (body.success) {
              observer.next({ status: 'done', progress: 100, file: body.file });
            } else {
              observer.next({ status: 'error', progress: 0, error: body.error || 'Upload failed' });
            }
          } catch {
            observer.next({ status: 'error', progress: 0, error: 'Invalid server response' });
          }
        } else {
          try {
            const body = JSON.parse(xhr.responseText);
            observer.next({ status: 'error', progress: 0, error: body.error || `Upload failed (${xhr.status})` });
          } catch {
            observer.next({ status: 'error', progress: 0, error: `Upload failed (${xhr.status})` });
          }
        }
        observer.complete();
      });

      xhr.addEventListener('error', () => {
        observer.next({ status: 'error', progress: 0, error: 'Network error during upload' });
        observer.complete();
      });

      xhr.addEventListener('abort', () => {
        observer.next({ status: 'error', progress: 0, error: 'Upload cancelled' });
        observer.complete();
      });

      xhr.open('POST', '/api/files/upload');
      xhr.withCredentials = true; // Send cookies for auth
      xhr.send(formData);

      // Cleanup on unsubscribe
      return () => {
        if (xhr.readyState !== XMLHttpRequest.DONE) {
          xhr.abort();
        }
      };
    });
  }

  getFiles(): Observable<FileInfo[]> {
    return this.http.get<FileInfo[]>('/api/files');
  }

  getDownloadUrl(fileId: string): string {
    return `/api/files/download/${fileId}`;
  }

  deleteFile(fileId: string): Observable<any> {
    return this.http.delete(`/api/files/${fileId}`);
  }
}
