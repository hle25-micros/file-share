import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEventType, HttpRequest } from '@angular/common/http';
import { Observable, map } from 'rxjs';

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

  getUploadConfig(): Observable<UploadConfig> {
    return this.http.get<UploadConfig>('/api/config/upload');
  }

  uploadFile(file: File): Observable<UploadProgress> {
    const formData = new FormData();
    formData.append('file', file, file.name);

    const req = new HttpRequest('POST', '/api/files/upload', formData, {
      reportProgress: true,
    });

    return this.http.request(req).pipe(
      map(event => {
        switch (event.type) {
          case HttpEventType.UploadProgress:
            const progress = event.total ? Math.round(100 * event.loaded / event.total) : 0;
            return { status: 'progress' as const, progress };
          case HttpEventType.Response:
            const body = event.body as any;
            if (body?.success) {
              return { status: 'done' as const, progress: 100, file: body.file };
            }
            return { status: 'error' as const, progress: 0, error: body?.error || 'Upload failed' };
          default:
            return { status: 'progress' as const, progress: 0 };
        }
      })
    );
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
