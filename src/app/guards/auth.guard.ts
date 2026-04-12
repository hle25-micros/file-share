import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { map, take } from 'rxjs';

export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.checkSession().pipe(
    take(1),
    map(res => {
      if (res.authenticated) {
        return true;
      }
      router.navigate(['/login']);
      return false;
    })
  );
};

export const loginGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.checkSession().pipe(
    take(1),
    map(res => {
      if (res.authenticated) {
        router.navigate(['/']);
        return false;
      }
      return true;
    })
  );
};
