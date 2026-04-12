import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, tap, catchError, of } from 'rxjs';
import { isPlatformBrowser } from '@angular/common';

export interface AuthState {
  authenticated: boolean;
  userId?: string;
  label?: string;
}

export interface LoginResponse {
  success: boolean;
  userId: string;
  label: string;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);

  private authState = new BehaviorSubject<AuthState>({ authenticated: false });
  authState$ = this.authState.asObservable();

  get isAuthenticated(): boolean {
    return this.authState.value.authenticated;
  }

  checkSession(): Observable<any> {
    if (!isPlatformBrowser(this.platformId)) {
      return of({ authenticated: false });
    }
    return this.http.get<{ authenticated: boolean; userId?: string }>('/api/auth/check').pipe(
      tap(res => {
        this.authState.next({
          authenticated: res.authenticated,
          userId: res.userId,
        });
      }),
      catchError(() => {
        this.authState.next({ authenticated: false });
        return of({ authenticated: false });
      })
    );
  }

  login(pin: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>('/api/auth/login', { pin }).pipe(
      tap(res => {
        if (res.success) {
          this.authState.next({
            authenticated: true,
            userId: res.userId,
            label: res.label,
          });
        }
      })
    );
  }

  logout(): Observable<any> {
    return this.http.post('/api/auth/logout', {}).pipe(
      tap(() => {
        this.authState.next({ authenticated: false });
      })
    );
  }
}
